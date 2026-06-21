import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/klaviyo — a tiny, dependency-free fake of the Klaviyo REST API.
//
// It speaks the exact wire protocol used by application code that calls the
// Klaviyo HTTP REST API directly with `axios` (the documented integration
// path), so app code and AI agents can run against it with zero cost and zero
// side effects. State is in-memory, ephemeral and resettable.
//
// Wire conventions replicated:
//   * Base path is `/api` for the modern JSON:API surface and `/client` for
//     the public, browser/SDK-facing endpoints.
//   * Modern endpoints follow the JSON:API spec:
//       request:  { data: { type, attributes, relationships? } }
//       response: { data: { type, id, attributes, links, relationships? },
//                   links, meta, included? }
//   * Private auth:  `Authorization: Klaviyo-Key <pk_...>`
//   * Public auth:   `?company_id=PUBLIC_KEY` on /client endpoints
//   * Every modern request carries a `revision` header (e.g. 2024-10-15).
//   * Errors use the JSON:API error envelope:
//       { errors: [ { id, status, code, title, detail, source } ] }
//
// Implemented surface (grouped):
//   Profiles          GET/POST   /api/profiles, GET/PATCH /api/profiles/{id}
//                     POST       /api/profile-import (upsert)
//                     POST       /api/profile-subscription-bulk-create-jobs
//                     POST       /api/profile-suppression-bulk-create-jobs
//   Lists             GET/POST   /api/lists, GET/PATCH/DELETE /api/lists/{id}
//                     GET        /api/lists/{id}/profiles
//                     POST/DELETE/api/lists/{id}/relationships/profiles
//   Segments          GET        /api/segments, GET /api/segments/{id}
//                     GET        /api/segments/{id}/profiles
//   Events            GET/POST   /api/events, GET /api/events/{id}
//   Metrics           GET        /api/metrics, GET /api/metrics/{id}
//                     POST       /api/metric-aggregates
//   Campaigns         GET/POST   /api/campaigns, GET/PATCH/DELETE /api/campaigns/{id}
//                     POST       /api/campaign-send-jobs
//   Templates         GET/POST   /api/templates, GET/PATCH/DELETE /api/templates/{id}
//   Tags              GET/POST   /api/tags, GET/PATCH/DELETE /api/tags/{id}
//   Flows             GET        /api/flows, GET /api/flows/{id}
//   Accounts          GET        /api/accounts
//   Client (public)   POST       /client/events
//                     POST       /client/profiles
//                     POST       /client/subscriptions
//                     POST       /client/push-tokens
//
// Plus parlel control/inspection endpoints under /__parlel.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newId(prefix = "") {
  const id = randomUUID();
  return prefix ? prefix + id : id;
}

// Klaviyo JSON:API error envelope.
function kError(status, code, title, detail, sourcePointer) {
  const err = {
    id: randomUUID(),
    status,
    code,
    title,
    detail,
    source: sourcePointer ? { pointer: sourcePointer } : {},
    links: {},
    meta: {},
  };
  return { errors: [err] };
}

export class KlaviyoServer {
  constructor(port = 4658, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.profiles = new Map(); // id -> profile record
    this.profilesByEmail = new Map(); // lowercased email -> id
    this.lists = new Map(); // id -> list record
    this.listMembers = new Map(); // listId -> Set(profileId)
    this.segments = new Map(); // id -> segment record
    this.segmentMembers = new Map(); // segmentId -> Set(profileId)
    this.events = new Map(); // id -> event record
    this.metrics = new Map(); // id -> metric record
    this.metricsByName = new Map(); // name -> id
    this.campaigns = new Map(); // id -> campaign record
    this.templates = new Map(); // id -> template record
    this.tags = new Map(); // id -> tag record
    this.flows = new Map(); // id -> flow record
    this.jobs = new Map(); // id -> bulk job record
    this._seedDefaults();
  }

  _seedDefaults() {
    // Klaviyo accounts always have built-in metrics for opens, clicks, etc.
    // Seed a couple so /api/metrics is never empty and events can attach.
    const placed = this._ensureMetric("Placed Order");
    const active = this._ensureMetric("Active on Site");
    void placed;
    void active;
  }

  _ensureMetric(name) {
    const existing = this.metricsByName.get(name);
    if (existing) return this.metrics.get(existing);
    const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
    const rec = {
      type: "metric",
      id,
      attributes: {
        name,
        created: now(),
        updated: now(),
        integration: { object: "integration", id: "0rG4eQ", name: "API", category: "API" },
      },
    };
    this.metrics.set(id, rec);
    this.metricsByName.set(name, id);
    return rec;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, kError("500", "server_error", "Server Error", error.message || "Unexpected error."));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, revision");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-klaviyo");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Health (unauthenticated).
    if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return this.send(res, 200, { status: "ok" });
    }

    // parlel inspection / control endpoints (unauthenticated).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Public client endpoints authenticate via ?company_id=PUBLIC_KEY.
    if (parts[0] === "client") {
      return this.routeClient(req, res, parts, body, url);
    }

    // Modern API surface lives under /api.
    if (parts[0] === "api") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, kError("401", "not_authenticated", "Authentication credentials were not provided.", "The request is missing a valid API key."));
      }
      return this.routeApi(req, res, parts.slice(1), body, url);
    }

    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  // =========================================================================
  // /api router
  // =========================================================================
  routeApi(req, res, parts, body, url) {
    const head = parts[0];
    switch (head) {
      case "accounts":
        return this.routeAccounts(req, res, parts, url);
      case "profiles":
        return this.routeProfiles(req, res, parts, body, url);
      case "profile-import":
        return this.profileImport(req, res, body);
      case "profile-subscription-bulk-create-jobs":
        return this.subscriptionBulkJob(req, res, body);
      case "profile-suppression-bulk-create-jobs":
        return this.suppressionBulkJob(req, res, body);
      case "lists":
        return this.routeLists(req, res, parts, body, url);
      case "segments":
        return this.routeSegments(req, res, parts, body, url);
      case "events":
        return this.routeEvents(req, res, parts, body, url);
      case "metrics":
        return this.routeMetrics(req, res, parts, body, url);
      case "metric-aggregates":
        return this.metricAggregates(req, res, body);
      case "campaigns":
        return this.routeCampaigns(req, res, parts, body, url);
      case "campaign-send-jobs":
        return this.campaignSendJob(req, res, body);
      case "templates":
        return this.routeTemplates(req, res, parts, body, url);
      case "tags":
        return this.routeTags(req, res, parts, body, url);
      case "flows":
        return this.routeFlows(req, res, parts, body, url);
      default:
        return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
    }
  }

  // =========================================================================
  // Accounts
  // =========================================================================
  routeAccounts(req, res, parts, url) {
    if (req.method !== "GET") return this.methodNotAllowed(res);
    const account = {
      type: "account",
      id: "PARLEL",
      attributes: {
        test_account: true,
        contact_information: {
          default_sender_name: "Parlel Test",
          default_sender_email: "test@parlel.test",
          organization_name: "Parlel",
          street_address: { address1: "1 Test St", address2: "", city: "Testville", region: "CA", country: "US", zip: "00000" },
        },
        industry: "software",
        timezone: "America/New_York",
        preferred_currency: "USD",
        public_api_key: "PARLEL",
        locale: "en-US",
      },
      links: { self: this._self(`/api/accounts/PARLEL`) },
    };
    if (parts.length === 2) {
      if (parts[1] !== "PARLEL") {
        return this.send(res, 404, kError("404", "not_found", "Not Found", "An account with the id PARLEL does not exist."));
      }
      return this.send(res, 200, { data: account, links: { self: this._self(url.pathname) } });
    }
    return this.send(res, 200, { data: [account], links: this._collLinks(url) });
  }

  // =========================================================================
  // Profiles
  // =========================================================================
  routeProfiles(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listProfiles(res, url);
      if (req.method === "POST") return this.createProfile(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") return this.getProfile(res, id, url);
      if (req.method === "PATCH") return this.updateProfile(res, id, body);
      return this.methodNotAllowed(res);
    }
    // /profiles/{id}/lists, /profiles/{id}/segments (related resources)
    if (parts.length === 3) {
      const profile = this.profiles.get(id);
      if (!profile) return this.send(res, 404, this._profileNotFound(id));
      if (parts[2] === "lists") {
        const data = Array.from(this.lists.values())
          .filter((l) => (this.listMembers.get(l.id) || new Set()).has(id))
          .map((l) => this._listView(l, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      if (parts[2] === "segments") {
        const data = Array.from(this.segments.values())
          .filter((s) => (this.segmentMembers.get(s.id) || new Set()).has(id))
          .map((s) => this._segmentView(s, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  listProfiles(res, url) {
    let data = Array.from(this.profiles.values());
    const filter = url.searchParams.get("filter");
    if (filter) {
      const m = filter.match(/equals\(([^,]+),"?([^")]+)"?\)/);
      if (m) {
        const field = m[1].trim();
        const value = m[2];
        data = data.filter((p) => {
          if (field === "email") return (p.attributes.email || "").toLowerCase() === value.toLowerCase();
          if (field === "phone_number") return p.attributes.phone_number === value;
          if (field === "id") return p.id === value;
          if (field === "external_id") return p.attributes.external_id === value;
          return true;
        });
      }
    }
    const views = data.map((p) => this._profileView(p, url.pathname));
    return this.send(res, 200, { data: views, links: this._collLinks(url) });
  }

  createProfile(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "profile") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "The payload must include `data` with type `profile`.", "/data/type"));
    }
    const attrs = data.attributes || {};
    const email = attrs.email ? String(attrs.email) : null;
    if (email && !EMAIL_RE.test(email)) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Invalid email address.", "/data/attributes/email"));
    }
    if (email && this.profilesByEmail.has(email.toLowerCase())) {
      const existingId = this.profilesByEmail.get(email.toLowerCase());
      const dup = kError("409", "duplicate_profile", "Conflict", `A profile already exists with one of these identifiers. Profile id: ${existingId}`);
      dup.errors[0].meta = { duplicate_profile_id: existingId };
      return this.send(res, 409, dup);
    }
    const rec = this._newProfile(attrs);
    return this.send(res, 201, { data: this._profileView(rec, "/api/profiles") });
  }

  _newProfile(attrs) {
    const id = newId().replace(/-/g, "").slice(0, 16);
    const rec = {
      type: "profile",
      id,
      attributes: {
        email: attrs.email || null,
        phone_number: attrs.phone_number || null,
        external_id: attrs.external_id || null,
        anonymous_id: attrs.anonymous_id || null,
        first_name: attrs.first_name || null,
        last_name: attrs.last_name || null,
        organization: attrs.organization || null,
        locale: attrs.locale || null,
        title: attrs.title || null,
        image: attrs.image || null,
        created: now(),
        updated: now(),
        last_event_date: null,
        location: attrs.location || {},
        properties: attrs.properties || {},
      },
    };
    this.profiles.set(id, rec);
    if (rec.attributes.email) this.profilesByEmail.set(rec.attributes.email.toLowerCase(), id);
    return rec;
  }

  getProfile(res, id, url) {
    const rec = this.profiles.get(id);
    if (!rec) return this.send(res, 404, this._profileNotFound(id));
    return this.send(res, 200, { data: this._profileView(rec, url.pathname) });
  }

  updateProfile(res, id, body) {
    const rec = this.profiles.get(id);
    if (!rec) return this.send(res, 404, this._profileNotFound(id));
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "profile") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "The payload must include `data` with type `profile`.", "/data/type"));
    }
    if (data.id && data.id !== id) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "The id in the payload does not match the URL.", "/data/id"));
    }
    const attrs = data.attributes || {};
    for (const key of ["email", "phone_number", "external_id", "first_name", "last_name", "organization", "locale", "title", "image", "anonymous_id"]) {
      if (key in attrs) {
        if (key === "email" && attrs.email && !EMAIL_RE.test(attrs.email)) {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Invalid email address.", "/data/attributes/email"));
        }
        if (key === "email") {
          if (rec.attributes.email) this.profilesByEmail.delete(rec.attributes.email.toLowerCase());
          if (attrs.email) this.profilesByEmail.set(String(attrs.email).toLowerCase(), id);
        }
        rec.attributes[key] = attrs[key];
      }
    }
    if (isPlainObject(attrs.location)) rec.attributes.location = { ...rec.attributes.location, ...attrs.location };
    if (isPlainObject(attrs.properties)) rec.attributes.properties = { ...rec.attributes.properties, ...attrs.properties };
    rec.attributes.updated = now();
    return this.send(res, 200, { data: this._profileView(rec, `/api/profiles/${id}`) });
  }

  profileImport(req, res, body) {
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "profile") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "The payload must include `data` with type `profile`.", "/data/type"));
    }
    const attrs = data.attributes || {};
    const email = attrs.email ? String(attrs.email).toLowerCase() : null;
    let rec;
    let created = false;
    if (email && this.profilesByEmail.has(email)) {
      rec = this.profiles.get(this.profilesByEmail.get(email));
      for (const key of ["phone_number", "external_id", "first_name", "last_name", "organization", "locale", "title", "image"]) {
        if (key in attrs) rec.attributes[key] = attrs[key];
      }
      if (isPlainObject(attrs.location)) rec.attributes.location = { ...rec.attributes.location, ...attrs.location };
      if (isPlainObject(attrs.properties)) rec.attributes.properties = { ...rec.attributes.properties, ...attrs.properties };
      rec.attributes.updated = now();
    } else {
      rec = this._newProfile(attrs);
      created = true;
    }
    return this.send(res, created ? 201 : 200, { data: this._profileView(rec, "/api/profile-import") });
  }

  subscriptionBulkJob(req, res, body) {
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "profile-subscription-bulk-create-job") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data of type profile-subscription-bulk-create-job.", "/data/type"));
    }
    const profiles = data.attributes?.profiles?.data || [];
    for (const p of profiles) {
      const email = p.attributes?.email ? String(p.attributes.email).toLowerCase() : null;
      if (email && !this.profilesByEmail.has(email)) {
        this._newProfile({ email: p.attributes.email });
      }
    }
    const id = newId();
    this.jobs.set(id, { type: "profile-subscription-bulk-create-job", id, status: "complete", created: now() });
    return this.send(res, 202, null);
  }

  suppressionBulkJob(req, res, body) {
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "profile-suppression-bulk-create-job") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data of type profile-suppression-bulk-create-job.", "/data/type"));
    }
    const id = newId();
    this.jobs.set(id, { type: "profile-suppression-bulk-create-job", id, status: "complete", created: now() });
    return this.send(res, 202, null);
  }

  _profileNotFound(id) {
    return kError("404", "not_found", "Not Found", `A profile with the id ${id} does not exist.`);
  }

  _profileView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/profiles/${rec.id}/`) };
    view.relationships = {
      lists: { links: { self: this._self(`/api/profiles/${rec.id}/relationships/lists/`), related: this._self(`/api/profiles/${rec.id}/lists/`) } },
      segments: { links: { self: this._self(`/api/profiles/${rec.id}/relationships/segments/`), related: this._self(`/api/profiles/${rec.id}/segments/`) } },
    };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Lists
  // =========================================================================
  routeLists(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listLists(res, url);
      if (req.method === "POST") return this.createList(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") return this.getList(res, id, url);
      if (req.method === "PATCH") return this.updateList(res, id, body);
      if (req.method === "DELETE") return this.deleteList(res, id);
      return this.methodNotAllowed(res);
    }
    const list = this.lists.get(id);
    if (!list) return this.send(res, 404, this._listNotFound(id));
    // /lists/{id}/profiles  (GET related)
    if (parts.length === 3 && parts[2] === "profiles") {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      const members = this.listMembers.get(id) || new Set();
      const data = Array.from(members).map((pid) => this._profileView(this.profiles.get(pid), url.pathname)).filter(Boolean);
      return this.send(res, 200, { data, links: this._collLinks(url) });
    }
    // /lists/{id}/relationships/profiles  (POST add, DELETE remove)
    if (parts.length === 4 && parts[2] === "relationships" && parts[3] === "profiles") {
      return this.listRelProfiles(req, res, id, body);
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  listLists(res, url) {
    const data = Array.from(this.lists.values()).map((l) => this._listView(l, url.pathname));
    return this.send(res, 200, { data, links: this._collLinks(url) });
  }

  createList(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "list" || !data.attributes || !data.attributes.name) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A list requires a name.", "/data/attributes/name"));
    }
    const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
    const rec = {
      type: "list",
      id,
      attributes: { name: String(data.attributes.name), created: now(), updated: now(), opt_in_process: "single_opt_in" },
    };
    this.lists.set(id, rec);
    this.listMembers.set(id, new Set());
    return this.send(res, 201, { data: this._listView(rec, "/api/lists") });
  }

  getList(res, id, url) {
    const rec = this.lists.get(id);
    if (!rec) return this.send(res, 404, this._listNotFound(id));
    return this.send(res, 200, { data: this._listView(rec, url.pathname) });
  }

  updateList(res, id, body) {
    const rec = this.lists.get(id);
    if (!rec) return this.send(res, 404, this._listNotFound(id));
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "list") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type list.", "/data/type"));
    }
    if (data.attributes && typeof data.attributes.name === "string") {
      rec.attributes.name = data.attributes.name;
      rec.attributes.updated = now();
    }
    return this.send(res, 200, { data: this._listView(rec, `/api/lists/${id}`) });
  }

  deleteList(res, id) {
    if (!this.lists.has(id)) return this.send(res, 404, this._listNotFound(id));
    this.lists.delete(id);
    this.listMembers.delete(id);
    return this.send(res, 204, null);
  }

  listRelProfiles(req, res, id, body) {
    const members = this.listMembers.get(id) || new Set();
    const refs = (body && body.data) || [];
    if (!Array.isArray(refs)) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "data must be an array of profile references.", "/data"));
    }
    for (const ref of refs) {
      if (!isPlainObject(ref) || ref.type !== "profile" || !ref.id) {
        return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Each reference must have type profile and id.", "/data"));
      }
      if (req.method === "POST") {
        if (!this.profiles.has(ref.id)) {
          return this.send(res, 404, this._profileNotFound(ref.id));
        }
        members.add(ref.id);
      } else if (req.method === "DELETE") {
        members.delete(ref.id);
      }
    }
    this.listMembers.set(id, members);
    if (req.method === "POST" || req.method === "DELETE") return this.send(res, 204, null);
    return this.methodNotAllowed(res);
  }

  _listNotFound(id) {
    return kError("404", "not_found", "Not Found", `A list with the id ${id} does not exist.`);
  }

  _listView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/lists/${rec.id}/`) };
    view.relationships = {
      profiles: { links: { self: this._self(`/api/lists/${rec.id}/relationships/profiles/`), related: this._self(`/api/lists/${rec.id}/profiles/`) } },
      tags: { links: { self: this._self(`/api/lists/${rec.id}/relationships/tags/`), related: this._self(`/api/lists/${rec.id}/tags/`) } },
    };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Segments (read-only in this fake — created implicitly via control API)
  // =========================================================================
  routeSegments(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const data = Array.from(this.segments.values()).map((s) => this._segmentView(s, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      if (req.method === "POST") return this.createSegment(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    const rec = this.segments.get(id);
    if (parts.length === 2) {
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, kError("404", "not_found", "Not Found", `A segment with the id ${id} does not exist.`));
        return this.send(res, 200, { data: this._segmentView(rec, url.pathname) });
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 3 && parts[2] === "profiles") {
      if (!rec) return this.send(res, 404, kError("404", "not_found", "Not Found", `A segment with the id ${id} does not exist.`));
      const members = this.segmentMembers.get(id) || new Set();
      const data = Array.from(members).map((pid) => this._profileView(this.profiles.get(pid), url.pathname)).filter(Boolean);
      return this.send(res, 200, { data, links: this._collLinks(url) });
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  createSegment(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "segment" || !data.attributes || !data.attributes.name) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A segment requires a name.", "/data/attributes/name"));
    }
    const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
    const rec = {
      type: "segment",
      id,
      attributes: {
        name: String(data.attributes.name),
        definition: data.attributes.definition || null,
        created: now(),
        updated: now(),
        is_active: true,
        is_processing: false,
        is_starred: false,
      },
    };
    this.segments.set(id, rec);
    this.segmentMembers.set(id, new Set());
    return this.send(res, 201, { data: this._segmentView(rec, "/api/segments") });
  }

  _segmentView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/segments/${rec.id}/`) };
    view.relationships = {
      profiles: { links: { self: this._self(`/api/segments/${rec.id}/relationships/profiles/`), related: this._self(`/api/segments/${rec.id}/profiles/`) } },
      tags: { links: { self: this._self(`/api/segments/${rec.id}/relationships/tags/`), related: this._self(`/api/segments/${rec.id}/tags/`) } },
    };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Events
  // =========================================================================
  routeEvents(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        let data = Array.from(this.events.values());
        const filter = url.searchParams.get("filter");
        if (filter) {
          const m = filter.match(/equals\(metric_id,"?([^")]+)"?\)/);
          if (m) data = data.filter((e) => e._metricId === m[1]);
        }
        const views = data.map((e) => this._eventView(e, url.pathname));
        return this.send(res, 200, { data: views, links: this._collLinks(url) });
      }
      if (req.method === "POST") return this.createEvent(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.events.get(id);
      if (!rec) return this.send(res, 404, kError("404", "not_found", "Not Found", `An event with the id ${id} does not exist.`));
      return this.send(res, 200, { data: this._eventView(rec, url.pathname) });
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  createEvent(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "event") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type event.", "/data/type"));
    }
    const attrs = data.attributes || {};
    const metricData = attrs.metric?.data;
    const metricName = metricData?.attributes?.name;
    if (!metricName) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "An event requires a metric name.", "/data/attributes/metric"));
    }
    const profileData = attrs.profile?.data;
    const profileAttrs = profileData?.attributes || {};
    if (!profileAttrs.email && !profileAttrs.phone_number && !profileAttrs.external_id && !profileAttrs.anonymous_id) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "An event requires a profile identifier.", "/data/attributes/profile"));
    }
    // Upsert profile by email if provided.
    let profileId = null;
    if (profileAttrs.email) {
      const lower = String(profileAttrs.email).toLowerCase();
      if (this.profilesByEmail.has(lower)) {
        profileId = this.profilesByEmail.get(lower);
      } else {
        profileId = this._newProfile(profileAttrs).id;
      }
    }
    const metric = this._ensureMetric(metricName);
    const id = newId().replace(/-/g, "");
    const rec = {
      type: "event",
      id,
      _metricId: metric.id,
      _profileId: profileId,
      attributes: {
        timestamp: attrs.time ? Math.floor(new Date(attrs.time).getTime() / 1000) : Math.floor(Date.now() / 1000),
        event_properties: attrs.properties || {},
        datetime: attrs.time || now(),
        uuid: id,
        value: attrs.value ?? null,
        value_currency: attrs.value_currency ?? null,
      },
    };
    this.events.set(id, rec);
    if (profileId) {
      const p = this.profiles.get(profileId);
      if (p) p.attributes.last_event_date = rec.attributes.datetime;
    }
    // Events endpoint returns 202 Accepted with no body in the real API.
    return this.send(res, 202, null);
  }

  _eventView(rec, selfPath) {
    const view = { type: "event", id: rec.id, attributes: clone(rec.attributes), links: { self: this._self(`/api/events/${rec.id}/`) } };
    view.relationships = {
      metric: { data: { type: "metric", id: rec._metricId }, links: { self: this._self(`/api/events/${rec.id}/relationships/metric/`), related: this._self(`/api/events/${rec.id}/metric/`) } },
    };
    if (rec._profileId) {
      view.relationships.profile = { data: { type: "profile", id: rec._profileId }, links: { self: this._self(`/api/events/${rec.id}/relationships/profile/`), related: this._self(`/api/events/${rec.id}/profile/`) } };
    }
    void selfPath;
    return view;
  }

  // =========================================================================
  // Metrics
  // =========================================================================
  routeMetrics(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const data = Array.from(this.metrics.values()).map((m) => this._metricView(m, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.metrics.get(id);
      if (!rec) return this.send(res, 404, kError("404", "not_found", "Not Found", `A metric with the id ${id} does not exist.`));
      return this.send(res, 200, { data: this._metricView(rec, url.pathname) });
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  metricAggregates(req, res, body) {
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "metric-aggregate") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type metric-aggregate.", "/data/type"));
    }
    const attrs = data.attributes || {};
    const metricId = attrs.metric_id;
    if (!metricId || !this.metrics.has(metricId)) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A valid metric_id is required.", "/data/attributes/metric_id"));
    }
    const measurements = attrs.measurements || ["count"];
    const count = Array.from(this.events.values()).filter((e) => e._metricId === metricId).length;
    const data0 = {};
    for (const m of measurements) data0[m] = m === "count" ? [count] : [0];
    const result = {
      type: "metric-aggregate",
      id: metricId,
      attributes: {
        dates: [now()],
        data: [{ dimensions: [], measurements: data0 }],
      },
    };
    return this.send(res, 200, { data: result, links: {} });
  }

  _metricView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/metrics/${rec.id}/`) };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Campaigns
  // =========================================================================
  routeCampaigns(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        // Klaviyo requires a messages.channel filter on campaigns list; we
        // accept any filter and just return all campaigns.
        const data = Array.from(this.campaigns.values()).map((c) => this._campaignView(c, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      if (req.method === "POST") return this.createCampaign(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      const rec = this.campaigns.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, this._campaignNotFound(id));
        return this.send(res, 200, { data: this._campaignView(rec, url.pathname) });
      }
      if (req.method === "PATCH") return this.updateCampaign(res, id, body);
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, this._campaignNotFound(id));
        this.campaigns.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  createCampaign(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "campaign" || !data.attributes || !data.attributes.name) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A campaign requires a name.", "/data/attributes/name"));
    }
    const id = newId();
    const attrs = data.attributes;
    const rec = {
      type: "campaign",
      id,
      attributes: {
        name: String(attrs.name),
        status: "Draft",
        archived: false,
        channel: attrs.audiences ? "email" : (attrs.send_options?.channel || "email"),
        message: attrs.message || null,
        audiences: attrs.audiences || { included: [], excluded: [] },
        send_options: attrs.send_options || { use_smart_sending: true },
        tracking_options: attrs.tracking_options || {},
        send_strategy: attrs.send_strategy || { method: "immediate" },
        created_at: now(),
        scheduled_at: null,
        updated_at: now(),
        send_time: null,
      },
    };
    this.campaigns.set(id, rec);
    return this.send(res, 201, { data: this._campaignView(rec, "/api/campaigns") });
  }

  updateCampaign(res, id, body) {
    const rec = this.campaigns.get(id);
    if (!rec) return this.send(res, 404, this._campaignNotFound(id));
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "campaign") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type campaign.", "/data/type"));
    }
    const attrs = data.attributes || {};
    for (const key of ["name", "audiences", "send_options", "tracking_options", "send_strategy"]) {
      if (key in attrs) rec.attributes[key] = attrs[key];
    }
    rec.attributes.updated_at = now();
    return this.send(res, 200, { data: this._campaignView(rec, `/api/campaigns/${id}`) });
  }

  campaignSendJob(req, res, body) {
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "campaign-send-job" || !data.id) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type campaign-send-job and an id.", "/data/id"));
    }
    const campaign = this.campaigns.get(data.id);
    if (!campaign) return this.send(res, 404, this._campaignNotFound(data.id));
    campaign.attributes.status = "Sent";
    campaign.attributes.send_time = now();
    return this.send(res, 202, null);
  }

  _campaignNotFound(id) {
    return kError("404", "not_found", "Not Found", `A campaign with the id ${id} does not exist.`);
  }

  _campaignView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/campaigns/${rec.id}/`) };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Templates
  // =========================================================================
  routeTemplates(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const data = Array.from(this.templates.values()).map((t) => this._templateView(t, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      if (req.method === "POST") return this.createTemplate(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      const rec = this.templates.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, this._templateNotFound(id));
        return this.send(res, 200, { data: this._templateView(rec, url.pathname) });
      }
      if (req.method === "PATCH") return this.updateTemplate(res, id, body);
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, this._templateNotFound(id));
        this.templates.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  createTemplate(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "template" || !data.attributes || !data.attributes.name) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A template requires a name.", "/data/attributes/name"));
    }
    const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
    const attrs = data.attributes;
    const rec = {
      type: "template",
      id,
      attributes: {
        name: String(attrs.name),
        editor_type: attrs.editor_type || "CODE",
        html: attrs.html || "",
        text: attrs.text || null,
        amp: attrs.amp || null,
        created: now(),
        updated: now(),
      },
    };
    this.templates.set(id, rec);
    return this.send(res, 201, { data: this._templateView(rec, "/api/templates") });
  }

  updateTemplate(res, id, body) {
    const rec = this.templates.get(id);
    if (!rec) return this.send(res, 404, this._templateNotFound(id));
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "template") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type template.", "/data/type"));
    }
    const attrs = data.attributes || {};
    for (const key of ["name", "html", "text", "amp", "editor_type"]) {
      if (key in attrs) rec.attributes[key] = attrs[key];
    }
    rec.attributes.updated = now();
    return this.send(res, 200, { data: this._templateView(rec, `/api/templates/${id}`) });
  }

  _templateNotFound(id) {
    return kError("404", "not_found", "Not Found", `A template with the id ${id} does not exist.`);
  }

  _templateView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/templates/${rec.id}/`) };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Tags
  // =========================================================================
  routeTags(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const data = Array.from(this.tags.values()).map((t) => this._tagView(t, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      if (req.method === "POST") return this.createTag(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      const rec = this.tags.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, this._tagNotFound(id));
        return this.send(res, 200, { data: this._tagView(rec, url.pathname) });
      }
      if (req.method === "PATCH") return this.updateTag(res, id, body);
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, this._tagNotFound(id));
        this.tags.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  createTag(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "tag" || !data.attributes || !data.attributes.name) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A tag requires a name.", "/data/attributes/name"));
    }
    const id = newId();
    const rec = { type: "tag", id, attributes: { name: String(data.attributes.name) } };
    this.tags.set(id, rec);
    return this.send(res, 201, { data: this._tagView(rec, "/api/tags") });
  }

  updateTag(res, id, body) {
    const rec = this.tags.get(id);
    if (!rec) return this.send(res, 404, this._tagNotFound(id));
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "tag") {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type tag.", "/data/type"));
    }
    if (data.attributes && typeof data.attributes.name === "string") rec.attributes.name = data.attributes.name;
    return this.send(res, 204, null);
  }

  _tagNotFound(id) {
    return kError("404", "not_found", "Not Found", `A tag with the id ${id} does not exist.`);
  }

  _tagView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/tags/${rec.id}/`) };
    void selfPath;
    return view;
  }

  // =========================================================================
  // Flows (read-only)
  // =========================================================================
  routeFlows(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const data = Array.from(this.flows.values()).map((f) => this._flowView(f, url.pathname));
        return this.send(res, 200, { data, links: this._collLinks(url) });
      }
      if (req.method === "POST") return this.createFlow(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.flows.get(id);
      if (!rec) return this.send(res, 404, kError("404", "not_found", "Not Found", `A flow with the id ${id} does not exist.`));
      return this.send(res, 200, { data: this._flowView(rec, url.pathname) });
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
  }

  createFlow(res, body) {
    const data = body && body.data;
    if (!isPlainObject(data) || data.type !== "flow" || !data.attributes || !data.attributes.name) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A flow requires a name.", "/data/attributes/name"));
    }
    const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
    const rec = {
      type: "flow",
      id,
      attributes: { name: String(data.attributes.name), status: "draft", archived: false, created: now(), updated: now(), trigger_type: "Added to List" },
    };
    this.flows.set(id, rec);
    return this.send(res, 201, { data: this._flowView(rec, "/api/flows") });
  }

  _flowView(rec, selfPath) {
    const view = clone(rec);
    view.links = { self: this._self(`/api/flows/${rec.id}/`) };
    void selfPath;
    return view;
  }

  // =========================================================================
  // /client public endpoints (browser/SDK facing)
  // =========================================================================
  routeClient(req, res, parts, body, url) {
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const companyId = url.searchParams.get("company_id");
    if (this.requireAuth && !companyId) {
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "A company_id query parameter is required.", "/company_id"));
    }
    const endpoint = parts[1];
    switch (endpoint) {
      case "events": {
        const data = body && body.data;
        if (!isPlainObject(data) || data.type !== "event") {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type event.", "/data/type"));
        }
        const metricName = data.attributes?.metric?.data?.attributes?.name;
        const profileAttrs = data.attributes?.profile?.data?.attributes || {};
        if (!metricName) {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "An event requires a metric name.", "/data/attributes/metric"));
        }
        if (!profileAttrs.email && !profileAttrs.phone_number && !profileAttrs.external_id && !profileAttrs.anonymous_id) {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "An event requires a profile identifier.", "/data/attributes/profile"));
        }
        const metric = this._ensureMetric(metricName);
        let profileId = null;
        if (profileAttrs.email) {
          const lower = String(profileAttrs.email).toLowerCase();
          profileId = this.profilesByEmail.get(lower) || this._newProfile(profileAttrs).id;
        }
        const id = newId().replace(/-/g, "");
        this.events.set(id, {
          type: "event", id, _metricId: metric.id, _profileId: profileId,
          attributes: { timestamp: Math.floor(Date.now() / 1000), event_properties: data.attributes.properties || {}, datetime: now(), uuid: id, value: data.attributes.value ?? null, value_currency: null },
        });
        return this.send(res, 202, null);
      }
      case "profiles": {
        const data = body && body.data;
        if (!isPlainObject(data) || data.type !== "profile") {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type profile.", "/data/type"));
        }
        const attrs = data.attributes || {};
        if (attrs.email) {
          const lower = String(attrs.email).toLowerCase();
          if (this.profilesByEmail.has(lower)) {
            const rec = this.profiles.get(this.profilesByEmail.get(lower));
            if (isPlainObject(attrs.properties)) rec.attributes.properties = { ...rec.attributes.properties, ...attrs.properties };
            rec.attributes.updated = now();
          } else {
            this._newProfile(attrs);
          }
        } else {
          this._newProfile(attrs);
        }
        return this.send(res, 202, null);
      }
      case "subscriptions": {
        const data = body && body.data;
        if (!isPlainObject(data) || data.type !== "subscription") {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type subscription.", "/data/type"));
        }
        const profileAttrs = data.attributes?.profile?.data?.attributes || {};
        if (profileAttrs.email && !this.profilesByEmail.has(String(profileAttrs.email).toLowerCase())) {
          this._newProfile(profileAttrs);
        }
        return this.send(res, 202, null);
      }
      case "push-tokens": {
        const data = body && body.data;
        if (!isPlainObject(data) || data.type !== "push-token") {
          return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Payload must include data with type push-token.", "/data/type"));
        }
        return this.send(res, 202, null);
      }
      default:
        return this.send(res, 404, kError("404", "not_found", "Not Found", "The requested resource was not found."));
    }
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
        profiles: this.profiles.size,
        lists: this.lists.size,
        segments: this.segments.size,
        events: this.events.size,
        metrics: this.metrics.size,
        campaigns: this.campaigns.size,
        templates: this.templates.size,
        tags: this.tags.size,
        flows: this.flows.size,
      });
    }
    // Seed helpers so read-only resources (segments/flows) can be tested.
    if (req.method === "POST" && parts[1] === "seed") {
      const kind = parts[2];
      const attrs = (body && body.attributes) || {};
      if (kind === "segment") {
        const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
        const rec = { type: "segment", id, attributes: { name: attrs.name || "Seeded Segment", definition: null, created: now(), updated: now(), is_active: true, is_processing: false, is_starred: false } };
        this.segments.set(id, rec);
        this.segmentMembers.set(id, new Set(attrs.profileIds || []));
        return this.send(res, 200, { data: this._segmentView(rec, "/__parlel") });
      }
      if (kind === "flow") {
        const id = newId().replace(/-/g, "").slice(0, 6).toUpperCase();
        const rec = { type: "flow", id, attributes: { name: attrs.name || "Seeded Flow", status: "live", archived: false, created: now(), updated: now(), trigger_type: "Added to List" } };
        this.flows.set(id, rec);
        return this.send(res, 200, { data: this._flowView(rec, "/__parlel") });
      }
      return this.send(res, 400, kError("400", "invalid", "Invalid Input", "Unknown seed kind."));
    }
    if (req.method === "GET" && parts[1] === "events") {
      return this.send(res, 200, { events: Array.from(this.events.values()).map(clone) });
    }
    return this.send(res, 404, kError("404", "not_found", "Not Found", "Not found."));
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // The Klaviyo private API authenticates with `Klaviyo-Key <pk_...>`.
    // Also accept a plain Bearer for flexibility.
    return /^Klaviyo-Key\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
  }

  methodNotAllowed(res) {
    return this.send(res, 405, kError("405", "method_not_allowed", "Method Not Allowed", "The method is not allowed for the requested resource."));
  }

  _self(path) {
    return `http://${this.host}:${this.port}${path}`;
  }

  _collLinks(url) {
    return { self: this._self(url.pathname + url.search), first: null, last: null, prev: null, next: null };
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
          this.send(res, 400, kError("400", "invalid", "Invalid Input", "The request body is not valid JSON."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, kError("400", "invalid", "Invalid Input", "Error reading request body."));
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
  const port = Number(process.env.PORT || process.env.KLAVIYO_PORT || 4658);
  const server = new KlaviyoServer(port);
  server.start().then(() => {
    // eslint-disable-next-line no-console
    console.log(`parlel/klaviyo listening on http://127.0.0.1:${port}`);
  });
}

export default KlaviyoServer;
