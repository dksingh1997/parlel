import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/activecampaign — a tiny, dependency-free fake of the ActiveCampaign
// v3 REST API.
//
// It speaks the exact wire protocol used by application code that calls the
// ActiveCampaign HTTP REST API directly with `axios` (the documented
// integration path), so app code and AI agents can run against it with zero
// cost and zero side effects. State is in-memory, ephemeral and resettable.
//
// Wire conventions replicated:
//   * Base path is `/api/3`.
//   * Auth via the `Api-Token: <token>` request header.
//   * Create/update bodies wrap the resource under a singular key, e.g.
//       POST /api/3/contacts   { "contact": { email, firstName, ... } }
//   * Single-resource responses wrap under the singular key:
//       { "contact": { id, email, ... } }
//   * Collection responses wrap under the plural key plus `meta`:
//       { "contacts": [ ... ], "meta": { "total": "N" } }
//   * IDs are returned as strings (ActiveCampaign serialises numeric ids as
//     strings on the wire).
//   * Validation errors use HTTP 422 with the envelope:
//       { "errors": [ { "title", "detail"?, "code"?, "source": { "pointer" } } ] }
//   * Missing auth returns HTTP 403 with { "message": "..." } (AC behaviour).
//
// Implemented surface (grouped):
//   Contacts        GET/POST   /api/3/contacts, GET/PUT/DELETE /api/3/contacts/{id}
//                   POST       /api/3/contact/sync  (upsert by email)
//                   GET        /api/3/contacts/{id}/contactTags
//                   GET        /api/3/contacts/{id}/contactLists
//                   GET        /api/3/contacts/{id}/fieldValues
//   Tags            GET/POST   /api/3/tags, GET/PUT/DELETE /api/3/tags/{id}
//   ContactTags     GET/POST   /api/3/contactTags, DELETE /api/3/contactTags/{id}
//   Lists           GET/POST   /api/3/lists, GET/PUT/DELETE /api/3/lists/{id}
//   ContactLists    POST       /api/3/contactLists (subscribe/unsubscribe)
//   CustomFields    GET/POST   /api/3/fields, GET/PUT/DELETE /api/3/fields/{id}
//   FieldValues     GET/POST   /api/3/fieldValues, GET/PUT/DELETE /api/3/fieldValues/{id}
//   Deals           GET/POST   /api/3/deals, GET/PUT/DELETE /api/3/deals/{id}
//   Pipelines       GET/POST   /api/3/dealGroups, GET/PUT/DELETE /api/3/dealGroups/{id}
//   Stages          GET/POST   /api/3/dealStages, GET/PUT/DELETE /api/3/dealStages/{id}
//   Notes           GET/POST   /api/3/notes, GET/PUT/DELETE /api/3/notes/{id}
//   Accounts        GET/POST   /api/3/accounts, GET/PUT/DELETE /api/3/accounts/{id}
//   Campaigns       GET        /api/3/campaigns, GET /api/3/campaigns/{id}
//   Automations     GET        /api/3/automations, GET /api/3/automations/{id}
//   ContactAutos    GET/POST   /api/3/contactAutomations, GET/DELETE /api/3/contactAutomations/{id}
//   Segments        GET        /api/3/segments, GET /api/3/segments/{id}
//   Users           GET        /api/3/users, GET /api/3/users/{id}
//   Webhooks        GET/POST   /api/3/webhooks, GET/PUT/DELETE /api/3/webhooks/{id}
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

// ActiveCampaign validation error envelope (HTTP 422).
//
// The real AC v3 error envelope is `{ "errors": [ { "title", "detail", "code" } ] }`.
// It does NOT use the JSON:API `source.pointer` convention — verified against the
// official OpenAPI 422 schemas (e.g. create-a-contact-custom-field). The legacy
// 4th `pointer` argument is accepted-and-ignored so existing call sites stay valid.
// Source: https://developers.activecampaign.com/reference/create-a-contact-custom-field.md
function acError(title, detail, code, _pointer) {
  const err = { title };
  if (detail) err.detail = detail;
  if (code) err.code = code;
  return { errors: [err] };
}

export class ActivecampaignServer {
  constructor(port = 4659, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.apiToken = options.apiToken || "parlel-test-api-token";
    this.server = null;
    this.reset();
  }

  reset() {
    this.seq = 1;
    this.contacts = new Map(); // id -> contact
    this.contactsByEmail = new Map(); // lowercased email -> id
    this.tags = new Map(); // id -> tag
    this.tagsByName = new Map(); // name -> id
    this.contactTags = new Map(); // id -> { contact, tag }
    this.lists = new Map(); // id -> list
    this.contactLists = new Map(); // id -> { contact, list, status }
    this.fields = new Map(); // id -> custom field definition
    this.fieldValues = new Map(); // id -> { contact, field, value }
    this.deals = new Map(); // id -> deal
    this.dealGroups = new Map(); // id -> pipeline
    this.dealStages = new Map(); // id -> stage
    this.notes = new Map(); // id -> note
    this.accounts = new Map(); // id -> account
    this.campaigns = new Map(); // id -> campaign (seeded, read-mostly)
    this.automations = new Map(); // id -> automation (seeded, read-only)
    this.contactAutomations = new Map(); // id -> { contact, automation }
    this.segments = new Map(); // id -> segment (seeded, read-only)
    this.users = new Map(); // id -> user (seeded, read-only)
    this.webhooks = new Map(); // id -> webhook
    this._seedDefaults();
  }

  _nextId() {
    return String(this.seq++);
  }

  _seedDefaults() {
    // Every AC account has a default pipeline + stages.
    const pipeline = {
      id: this._nextId(),
      title: "Default Pipeline",
      currency: "usd",
      allgroups: "1",
      allusers: "1",
      autogenerate_id: "0",
      cdate: now(),
      udate: now(),
    };
    this.dealGroups.set(pipeline.id, pipeline);

    const stageNames = ["To Contact", "Contacted", "Negotiation", "Won", "Lost"];
    stageNames.forEach((title, i) => {
      const id = this._nextId();
      this.dealStages.set(id, {
        id,
        title,
        group: pipeline.id,
        order: String(i),
        color: "008800",
        width: "280",
        dealOrder: "next-action ASC",
        cdate: now(),
        udate: now(),
      });
    });

    // A default user.
    const user = {
      id: this._nextId(),
      username: "parlel",
      firstName: "Parlel",
      lastName: "Test",
      email: "test@parlel.test",
      phone: "",
      signature: "",
    };
    this.users.set(user.id, user);

    // A seeded campaign + automation + segment so read-only listings aren't empty.
    const campaign = {
      id: this._nextId(),
      type: "single",
      name: "Welcome Campaign",
      status: "5",
      cdate: now(),
      mdate: now(),
      sdate: now(),
      send_amt: "0",
      total_amt: "0",
      opens: "0",
      uniqueopens: "0",
      linkclicks: "0",
      subscriberclicks: "0",
    };
    this.campaigns.set(campaign.id, campaign);

    const automation = {
      id: this._nextId(),
      name: "Welcome Series",
      cdate: now(),
      mdate: now(),
      status: "1",
      entered: "0",
      exited: "0",
    };
    this.automations.set(automation.id, automation);

    const segment = {
      id: this._nextId(),
      name: "Active Customers",
      logic: "all",
      cdate: now(),
      mdate: now(),
    };
    this.segments.set(segment.id, segment);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal Server Error" });
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
    res.setHeader("Access-Control-Allow-Headers", "Api-Token, Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-activecampaign");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Health (unauthenticated).
    if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return this.send(res, 200, { status: "ok" });
    }

    // parlel inspection / control endpoints (unauthenticated).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Modern API surface lives under /api/3.
    if (parts[0] === "api" && parts[1] === "3") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 403, { message: "You do not have permission to view this directory or page." });
      }
      return this.routeApi(req, res, parts.slice(2), body, url);
    }

    return this.send(res, 404, { message: "No Result." });
  }

  // =========================================================================
  // /api/3 router
  // =========================================================================
  routeApi(req, res, parts, body, url) {
    const head = parts[0];
    switch (head) {
      case "contacts":
        return this.routeContacts(req, res, parts, body, url);
      case "contact":
        return this.routeContactSync(req, res, parts, body);
      case "tags":
        return this.routeTags(req, res, parts, body, url);
      case "contactTags":
        return this.routeContactTags(req, res, parts, body, url);
      case "lists":
        return this.routeLists(req, res, parts, body, url);
      case "contactLists":
        return this.routeContactLists(req, res, parts, body, url);
      case "fields":
        return this.routeFields(req, res, parts, body, url);
      case "fieldValues":
        return this.routeFieldValues(req, res, parts, body, url);
      case "deals":
        return this.routeDeals(req, res, parts, body, url);
      case "dealGroups":
        return this.routeDealGroups(req, res, parts, body, url);
      case "dealStages":
        return this.routeDealStages(req, res, parts, body, url);
      case "notes":
        return this.routeNotes(req, res, parts, body, url);
      case "accounts":
        return this.routeAccounts(req, res, parts, body, url);
      case "campaigns":
        return this.routeCampaigns(req, res, parts, body, url);
      case "automations":
        return this.routeAutomations(req, res, parts, body, url);
      case "contactAutomations":
        return this.routeContactAutomations(req, res, parts, body, url);
      case "segments":
        return this.routeSegments(req, res, parts, body, url);
      case "users":
        return this.routeUsers(req, res, parts, body, url);
      case "webhooks":
        return this.routeWebhooks(req, res, parts, body, url);
      default:
        return this.send(res, 404, { message: "No Result." });
    }
  }

  // =========================================================================
  // Contacts
  // =========================================================================
  routeContacts(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listContacts(res, url);
      if (req.method === "POST") return this.createContact(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") return this.getContact(res, id);
      if (req.method === "PUT") return this.updateContact(res, id, body);
      if (req.method === "DELETE") return this.deleteContact(res, id);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 3 && req.method === "GET") {
      const contact = this.contacts.get(id);
      if (!contact) return this.send(res, 404, { message: "No Result." });
      if (parts[2] === "contactTags") {
        const data = Array.from(this.contactTags.values()).filter((ct) => ct.contact === id);
        return this.send(res, 200, { contactTags: data.map((ct) => this._contactTagView(ct)), meta: { total: String(data.length) } });
      }
      if (parts[2] === "contactLists") {
        const data = Array.from(this.contactLists.values()).filter((cl) => cl.contact === id);
        return this.send(res, 200, { contactLists: data.map((cl) => this._contactListView(cl)), meta: { total: String(data.length) } });
      }
      if (parts[2] === "fieldValues") {
        const data = Array.from(this.fieldValues.values()).filter((fv) => fv.contact === id);
        return this.send(res, 200, { fieldValues: data.map((fv) => this._fieldValueView(fv)), meta: { total: String(data.length) } });
      }
    }
    return this.send(res, 404, { message: "No Result." });
  }

  listContacts(res, url) {
    let data = Array.from(this.contacts.values());
    const email = url.searchParams.get("email");
    if (email) data = data.filter((c) => (c.email || "").toLowerCase() === email.toLowerCase());
    const search = url.searchParams.get("search");
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((c) =>
        (c.email || "").toLowerCase().includes(q) ||
        (c.firstName || "").toLowerCase().includes(q) ||
        (c.lastName || "").toLowerCase().includes(q));
    }
    // listid filter -> contacts subscribed to that list.
    const listid = url.searchParams.get("listid");
    if (listid) {
      const members = new Set(
        Array.from(this.contactLists.values())
          .filter((cl) => cl.list === String(listid) && cl.status === "1")
          .map((cl) => cl.contact),
      );
      data = data.filter((c) => members.has(c.id));
    }
    const total = data.length;
    const { offset, limit } = this._paginate(url);
    const page = data.slice(offset, offset + limit);
    return this.send(res, 200, { contacts: page.map((c) => this._contactView(c)), meta: { total: String(total) } });
  }

  createContact(res, body) {
    const input = body && body.contact;
    if (!isPlainObject(input)) {
      return this.send(res, 422, acError("The Contact must include an email address.", "Missing required field `email`.", "email", "/data/attributes/email"));
    }
    const email = input.email ? String(input.email) : "";
    if (!email) {
      return this.send(res, 422, acError("Email address not valid.", "An email address is required.", "email", "/data/attributes/email"));
    }
    if (!EMAIL_RE.test(email)) {
      return this.send(res, 422, acError("Email address not valid.", `The email '${email}' is not valid.`, "email", "/data/attributes/email"));
    }
    if (this.contactsByEmail.has(email.toLowerCase())) {
      return this.send(res, 422, acError("Email address already exists in the system", "Duplicate contact email.", "duplicate", "/data/attributes/email"));
    }
    const rec = this._newContact(input);
    this._applyInlineFieldValues(rec.id, input.fieldValues);
    return this.send(res, 201, { contact: this._contactView(rec) });
  }

  // Upsert inline `contact.fieldValues: [{ field, value }]` against existing
  // field definitions. Unknown field ids are ignored, matching the real API's
  // lenient handling rather than erroring. Returns the affected fieldValue recs.
  // Source: Pipedream base-contact.getFieldValues + sync-a-contacts-data OpenAPI.
  _applyInlineFieldValues(contactId, fieldValues) {
    const out = [];
    if (!Array.isArray(fieldValues)) return out;
    for (const entry of fieldValues) {
      if (!isPlainObject(entry) || entry.field === undefined) continue;
      const field = String(entry.field);
      if (!this.fields.has(field)) continue;
      let rec = null;
      for (const fv of this.fieldValues.values()) {
        if (fv.contact === contactId && fv.field === field) { rec = fv; break; }
      }
      const value = entry.value !== undefined ? String(entry.value) : "";
      if (rec) {
        rec.value = value;
        rec.udate = now();
      } else {
        const id = this._nextId();
        rec = { id, contact: contactId, field, value, cdate: now(), udate: now() };
        this.fieldValues.set(id, rec);
      }
      out.push(rec);
    }
    return out;
  }

  _newContact(input) {
    const id = this._nextId();
    const rec = {
      id,
      email: input.email,
      firstName: input.firstName || "",
      lastName: input.lastName || "",
      phone: input.phone || "",
      orgid: input.orgid ? String(input.orgid) : "0",
      cdate: now(),
      udate: now(),
      deleted: "0",
    };
    this.contacts.set(id, rec);
    this.contactsByEmail.set(rec.email.toLowerCase(), id);
    return rec;
  }

  getContact(res, id) {
    const rec = this.contacts.get(id);
    if (!rec) return this.send(res, 404, { message: "No Result." });
    return this.send(res, 200, { contact: this._contactView(rec) });
  }

  updateContact(res, id, body) {
    const rec = this.contacts.get(id);
    if (!rec) return this.send(res, 404, { message: "No Result." });
    const input = (body && body.contact) || {};
    if (input.email !== undefined) {
      const email = String(input.email);
      if (!EMAIL_RE.test(email)) {
        return this.send(res, 422, acError("Email address not valid.", `The email '${email}' is not valid.`, "email", "/data/attributes/email"));
      }
      const existing = this.contactsByEmail.get(email.toLowerCase());
      if (existing && existing !== id) {
        return this.send(res, 422, acError("Email address already exists in the system", "Duplicate contact email.", "duplicate", "/data/attributes/email"));
      }
      this.contactsByEmail.delete(rec.email.toLowerCase());
      rec.email = email;
      this.contactsByEmail.set(email.toLowerCase(), id);
    }
    for (const k of ["firstName", "lastName", "phone"]) {
      if (input[k] !== undefined) rec[k] = String(input[k]);
    }
    if (input.orgid !== undefined) rec.orgid = String(input.orgid);
    rec.udate = now();
    return this.send(res, 200, { contact: this._contactView(rec) });
  }

  deleteContact(res, id) {
    const rec = this.contacts.get(id);
    if (!rec) return this.send(res, 404, { message: "No Result." });
    this.contacts.delete(id);
    this.contactsByEmail.delete(rec.email.toLowerCase());
    // Cascade contact-scoped relations.
    for (const [ctId, ct] of this.contactTags) if (ct.contact === id) this.contactTags.delete(ctId);
    for (const [clId, cl] of this.contactLists) if (cl.contact === id) this.contactLists.delete(clId);
    for (const [fvId, fv] of this.fieldValues) if (fv.contact === id) this.fieldValues.delete(fvId);
    return this.send(res, 200, {});
  }

  _contactView(rec) {
    const links = {
      bounceLogs: this._link(`/api/3/contacts/${rec.id}/bounceLogs`),
      contactAutomations: this._link(`/api/3/contacts/${rec.id}/contactAutomations`),
      contactData: this._link(`/api/3/contacts/${rec.id}/contactData`),
      contactGoals: this._link(`/api/3/contacts/${rec.id}/contactGoals`),
      contactLists: this._link(`/api/3/contacts/${rec.id}/contactLists`),
      contactLogs: this._link(`/api/3/contacts/${rec.id}/contactLogs`),
      contactTags: this._link(`/api/3/contacts/${rec.id}/contactTags`),
      contactDeals: this._link(`/api/3/contacts/${rec.id}/contactDeals`),
      deals: this._link(`/api/3/contacts/${rec.id}/deals`),
      fieldValues: this._link(`/api/3/contacts/${rec.id}/fieldValues`),
      geoIps: this._link(`/api/3/contacts/${rec.id}/geoIps`),
      notes: this._link(`/api/3/contacts/${rec.id}/notes`),
      organization: this._link(`/api/3/contacts/${rec.id}/organization`),
      plusAppend: this._link(`/api/3/contacts/${rec.id}/plusAppend`),
      trackingLogs: this._link(`/api/3/contacts/${rec.id}/trackingLogs`),
      scoreValues: this._link(`/api/3/contacts/${rec.id}/scoreValues`),
    };
    return {
      cdate: rec.cdate,
      email: rec.email,
      phone: rec.phone,
      firstName: rec.firstName,
      lastName: rec.lastName,
      orgid: rec.orgid,
      segmentio_id: "",
      bounced_hard: "0",
      bounced_soft: "0",
      bounced_date: null,
      ip: "0",
      ua: null,
      hash: "",
      socialdata_lastcheck: null,
      email_local: "",
      email_domain: "",
      sentcnt: "0",
      rating_tstamp: null,
      gravatar: "0",
      deleted: rec.deleted,
      adate: null,
      udate: rec.udate,
      edate: null,
      contactAutomations: [],
      contactLists: [],
      fieldValues: [],
      geoIps: [],
      deals: [],
      accountContacts: [],
      links,
      id: rec.id,
      organization: rec.orgid !== "0" ? rec.orgid : null,
    };
  }

  // POST /api/3/contact/sync — upsert by email.
  routeContactSync(req, res, parts, body) {
    if (parts[1] !== "sync") return this.send(res, 404, { message: "No Result." });
    if (req.method !== "POST") return this.methodNotAllowed(res);
    const input = body && body.contact;
    if (!isPlainObject(input) || !input.email) {
      return this.send(res, 422, acError("Email address not valid.", "An email address is required.", "email", "/data/attributes/email"));
    }
    const email = String(input.email);
    if (!EMAIL_RE.test(email)) {
      return this.send(res, 422, acError("Email address not valid.", `The email '${email}' is not valid.`, "email", "/data/attributes/email"));
    }
    // The real `/contact/sync` endpoint always responds with HTTP 201 (whether it
    // created or updated the contact) and wraps a top-level `fieldValues` array
    // alongside `contact`. Source: sync-a-contacts-data OpenAPI
    // (https://developers.activecampaign.com/reference/sync-a-contacts-data.md).
    const existingId = this.contactsByEmail.get(email.toLowerCase());
    let rec;
    if (existingId) {
      rec = this.contacts.get(existingId);
      for (const k of ["firstName", "lastName", "phone"]) {
        if (input[k] !== undefined) rec[k] = String(input[k]);
      }
      if (input.orgid !== undefined) rec.orgid = String(input.orgid);
      rec.udate = now();
    } else {
      rec = this._newContact(input);
    }
    this._applyInlineFieldValues(rec.id, input.fieldValues);
    const fvs = Array.from(this.fieldValues.values())
      .filter((fv) => fv.contact === rec.id)
      .map((fv) => this._fieldValueView(fv));
    return this.send(res, 201, { fieldValues: fvs, contact: this._contactView(rec) });
  }

  // =========================================================================
  // Tags
  // =========================================================================
  routeTags(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.tags, "tags", (t) => this._tagView(t));
      if (req.method === "POST") return this.createTag(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.tags.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { tag: this._tagView(rec) });
      }
      if (req.method === "PUT") return this.updateTag(res, id, body);
      if (req.method === "DELETE") {
        const rec = this.tags.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        this.tags.delete(id);
        this.tagsByName.delete(rec.tag);
        for (const [ctId, ct] of this.contactTags) if (ct.tag === id) this.contactTags.delete(ctId);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createTag(res, body) {
    const input = body && body.tag;
    if (!isPlainObject(input) || !input.tag) {
      return this.send(res, 422, acError("Tag name is required.", "Missing required field `tag`.", "tag", "/data/attributes/tag"));
    }
    const name = String(input.tag);
    if (this.tagsByName.has(name)) {
      return this.send(res, 422, acError("Duplicate", "A tag with this name already exists.", "duplicate", "/data/attributes/tag"));
    }
    const id = this._nextId();
    const rec = {
      id,
      tag: name,
      tagType: input.tagType || "contact",
      description: input.description || "",
      cdate: now(),
    };
    this.tags.set(id, rec);
    this.tagsByName.set(name, id);
    return this.send(res, 201, { tag: this._tagView(rec) });
  }

  updateTag(res, id, body) {
    const rec = this.tags.get(id);
    if (!rec) return this.send(res, 404, { message: "No Result." });
    const input = (body && body.tag) || {};
    if (input.tag !== undefined) {
      const name = String(input.tag);
      const existing = this.tagsByName.get(name);
      if (existing && existing !== id) {
        return this.send(res, 422, acError("Duplicate", "A tag with this name already exists.", "duplicate", "/data/attributes/tag"));
      }
      this.tagsByName.delete(rec.tag);
      rec.tag = name;
      this.tagsByName.set(name, id);
    }
    if (input.description !== undefined) rec.description = String(input.description);
    if (input.tagType !== undefined) rec.tagType = String(input.tagType);
    return this.send(res, 200, { tag: this._tagView(rec) });
  }

  _tagView(rec) {
    return {
      id: rec.id,
      tag: rec.tag,
      tagType: rec.tagType,
      description: rec.description,
      cdate: rec.cdate,
      links: { contactGoalTags: this._link(`/api/3/tags/${rec.id}/contactGoalTags`) },
    };
  }

  // =========================================================================
  // ContactTags (apply a tag to a contact)
  // =========================================================================
  routeContactTags(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.contactTags, "contactTags", (ct) => this._contactTagView(ct));
      if (req.method === "POST") return this.createContactTag(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.contactTags.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { contactTag: this._contactTagView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.contactTags.has(id)) return this.send(res, 404, { message: "No Result." });
        this.contactTags.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createContactTag(res, body) {
    const input = body && body.contactTag;
    if (!isPlainObject(input) || input.contact === undefined || input.tag === undefined) {
      return this.send(res, 422, acError("Contact and tag are required.", "Missing required fields.", "required", "/data/attributes/contact"));
    }
    const contact = String(input.contact);
    const tag = String(input.tag);
    if (!this.contacts.has(contact)) {
      return this.send(res, 422, acError("Related Contact not found.", `Contact ${contact} does not exist.`, "not_found", "/data/attributes/contact"));
    }
    if (!this.tags.has(tag)) {
      return this.send(res, 422, acError("Related Tag not found.", `Tag ${tag} does not exist.`, "not_found", "/data/attributes/tag"));
    }
    // Idempotent: re-applying returns the existing link.
    for (const ct of this.contactTags.values()) {
      if (ct.contact === contact && ct.tag === tag) {
        return this.send(res, 201, { contactTag: this._contactTagView(ct) });
      }
    }
    const id = this._nextId();
    const rec = { id, contact, tag, cdate: now() };
    this.contactTags.set(id, rec);
    return this.send(res, 201, { contactTag: this._contactTagView(rec) });
  }

  _contactTagView(rec) {
    return {
      id: rec.id,
      contact: rec.contact,
      tag: rec.tag,
      cdate: rec.cdate,
      links: { tag: this._link(`/api/3/contactTags/${rec.id}/tag`), contact: this._link(`/api/3/contactTags/${rec.id}/contact`) },
    };
  }

  // =========================================================================
  // Lists
  // =========================================================================
  routeLists(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.lists, "lists", (l) => this._listView(l));
      if (req.method === "POST") return this.createList(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.lists.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { list: this._listView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.lists.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.list) || {};
        for (const k of ["name", "stringid", "sender_url", "sender_reminder"]) {
          if (input[k] !== undefined) rec[k] = String(input[k]);
        }
        rec.udate = now();
        return this.send(res, 200, { list: this._listView(rec) });
      }
      if (req.method === "DELETE") {
        const rec = this.lists.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        this.lists.delete(id);
        for (const [clId, cl] of this.contactLists) if (cl.list === id) this.contactLists.delete(clId);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createList(res, body) {
    const input = body && body.list;
    if (!isPlainObject(input) || !input.name) {
      return this.send(res, 422, acError("List name is required.", "Missing required field `name`.", "name", "/data/attributes/name"));
    }
    const id = this._nextId();
    const rec = {
      id,
      name: String(input.name),
      stringid: input.stringid ? String(input.stringid) : String(input.name).toLowerCase().replace(/\s+/g, "-"),
      sender_url: input.sender_url || "https://parlel.test",
      sender_reminder: input.sender_reminder || "You signed up on our website.",
      userid: input.userid ? String(input.userid) : "1",
      cdate: now(),
      udate: now(),
    };
    this.lists.set(id, rec);
    return this.send(res, 201, { list: this._listView(rec) });
  }

  _listView(rec) {
    return {
      id: rec.id,
      name: rec.name,
      stringid: rec.stringid,
      sender_url: rec.sender_url,
      sender_reminder: rec.sender_reminder,
      userid: rec.userid,
      cdate: rec.cdate,
      udate: rec.udate,
      subscriber_count: String(
        Array.from(this.contactLists.values()).filter((cl) => cl.list === rec.id && cl.status === "1").length,
      ),
      links: { contactGoalLists: this._link(`/api/3/lists/${rec.id}/contactGoalLists`), user: this._link(`/api/3/lists/${rec.id}/user`) },
    };
  }

  // =========================================================================
  // ContactLists (subscribe / unsubscribe a contact to/from a list)
  // =========================================================================
  routeContactLists(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.contactLists, "contactLists", (cl) => this._contactListView(cl));
      if (req.method === "POST") return this.createContactList(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.contactLists.get(id);
      if (!rec) return this.send(res, 404, { message: "No Result." });
      return this.send(res, 200, { contactList: this._contactListView(rec) });
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createContactList(res, body) {
    const input = body && body.contactList;
    if (!isPlainObject(input) || input.list === undefined || input.contact === undefined || input.status === undefined) {
      return this.send(res, 422, acError("List, contact and status are required.", "Missing required fields.", "required", "/data/attributes/list"));
    }
    const list = String(input.list);
    const contact = String(input.contact);
    const status = String(input.status); // "1" subscribe, "2" unsubscribe
    if (!this.lists.has(list)) {
      return this.send(res, 422, acError("Related List not found.", `List ${list} does not exist.`, "not_found", "/data/attributes/list"));
    }
    if (!this.contacts.has(contact)) {
      return this.send(res, 422, acError("Related Contact not found.", `Contact ${contact} does not exist.`, "not_found", "/data/attributes/contact"));
    }
    let rec = null;
    for (const cl of this.contactLists.values()) {
      if (cl.list === list && cl.contact === contact) { rec = cl; break; }
    }
    if (rec) {
      rec.status = status;
      rec.udate = now();
    } else {
      const id = this._nextId();
      rec = { id, list, contact, status, cdate: now(), udate: now() };
      this.contactLists.set(id, rec);
    }
    return this.send(res, 200, {
      contacts: [this._contactView(this.contacts.get(contact))],
      contactList: this._contactListView(rec),
    });
  }

  _contactListView(rec) {
    return {
      id: rec.id,
      contact: rec.contact,
      list: rec.list,
      status: rec.status,
      cdate: rec.cdate,
      udate: rec.udate,
      links: { contact: this._link(`/api/3/contactLists/${rec.id}/contact`), list: this._link(`/api/3/contactLists/${rec.id}/list`) },
    };
  }

  // =========================================================================
  // Custom Fields
  // =========================================================================
  routeFields(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.fields, "fields", (f) => this._fieldView(f));
      if (req.method === "POST") return this.createField(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.fields.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { field: this._fieldView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.fields.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.field) || {};
        for (const k of ["title", "descript", "type"]) {
          if (input[k] !== undefined) rec[k] = String(input[k]);
        }
        rec.udate = now();
        return this.send(res, 200, { field: this._fieldView(rec) });
      }
      if (req.method === "DELETE") {
        const rec = this.fields.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        this.fields.delete(id);
        for (const [fvId, fv] of this.fieldValues) if (fv.field === id) this.fieldValues.delete(fvId);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createField(res, body) {
    const input = body && body.field;
    if (!isPlainObject(input) || !input.title || !input.type) {
      return this.send(res, 422, acError("The field title was not provided.", "Both `title` and `type` are required.", "field_missing"));
    }
    const id = this._nextId();
    const rec = {
      id,
      title: String(input.title),
      descript: input.descript || "",
      type: String(input.type),
      isrequired: input.isrequired ? "1" : "0",
      perstag: input.perstag || String(input.title).toUpperCase().replace(/\s+/g, "_"),
      defval: input.defval || "",
      visible: input.visible !== undefined ? String(input.visible) : "1",
      ordernum: input.ordernum ? String(input.ordernum) : "0",
      cdate: now(),
      udate: now(),
    };
    this.fields.set(id, rec);
    return this.send(res, 201, { field: this._fieldView(rec) });
  }

  _fieldView(rec) {
    return {
      id: rec.id,
      title: rec.title,
      descript: rec.descript,
      type: rec.type,
      isrequired: rec.isrequired,
      perstag: rec.perstag,
      defval: rec.defval,
      visible: rec.visible,
      ordernum: rec.ordernum,
      cdate: rec.cdate,
      udate: rec.udate,
      links: { options: this._link(`/api/3/fields/${rec.id}/options`), relations: this._link(`/api/3/fields/${rec.id}/relations`) },
    };
  }

  // =========================================================================
  // Field Values
  // =========================================================================
  routeFieldValues(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.fieldValues, "fieldValues", (fv) => this._fieldValueView(fv));
      if (req.method === "POST") return this.createFieldValue(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.fieldValues.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { fieldValue: this._fieldValueView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.fieldValues.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.fieldValue) || {};
        if (input.value !== undefined) rec.value = String(input.value);
        rec.udate = now();
        return this.send(res, 200, { fieldValue: this._fieldValueView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.fieldValues.has(id)) return this.send(res, 404, { message: "No Result." });
        this.fieldValues.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createFieldValue(res, body) {
    const input = body && body.fieldValue;
    if (!isPlainObject(input) || input.contact === undefined || input.field === undefined) {
      return this.send(res, 422, acError("Contact and field are required.", "Missing required fields.", "required", "/data/attributes/contact"));
    }
    const contact = String(input.contact);
    const field = String(input.field);
    if (!this.contacts.has(contact)) {
      return this.send(res, 422, acError("Related Contact not found.", `Contact ${contact} does not exist.`, "not_found", "/data/attributes/contact"));
    }
    if (!this.fields.has(field)) {
      return this.send(res, 422, acError("Related Field not found.", `Field ${field} does not exist.`, "not_found", "/data/attributes/field"));
    }
    // Upsert: one value per (contact, field).
    let rec = null;
    for (const fv of this.fieldValues.values()) {
      if (fv.contact === contact && fv.field === field) { rec = fv; break; }
    }
    if (rec) {
      rec.value = input.value !== undefined ? String(input.value) : "";
      rec.udate = now();
    } else {
      const id = this._nextId();
      rec = { id, contact, field, value: input.value !== undefined ? String(input.value) : "", cdate: now(), udate: now() };
      this.fieldValues.set(id, rec);
    }
    return this.send(res, 201, { fieldValue: this._fieldValueView(rec) });
  }

  _fieldValueView(rec) {
    return {
      id: rec.id,
      contact: rec.contact,
      field: rec.field,
      value: rec.value,
      cdate: rec.cdate,
      udate: rec.udate,
      links: { field: this._link(`/api/3/fieldValues/${rec.id}/field`), owner: this._link(`/api/3/fieldValues/${rec.id}/owner`) },
    };
  }

  // =========================================================================
  // Deals
  // =========================================================================
  routeDeals(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.deals, "deals", (d) => this._dealView(d));
      if (req.method === "POST") return this.createDeal(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.deals.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { deal: this._dealView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.deals.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.deal) || {};
        for (const k of ["title", "description", "status", "currency"]) {
          if (input[k] !== undefined) rec[k] = String(input[k]);
        }
        if (input.value !== undefined) rec.value = String(input.value);
        if (input.stage !== undefined) rec.stage = String(input.stage);
        if (input.group !== undefined) rec.group = String(input.group);
        rec.mdate = now();
        return this.send(res, 200, { deal: this._dealView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.deals.has(id)) return this.send(res, 404, { message: "No Result." });
        this.deals.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createDeal(res, body) {
    const input = body && body.deal;
    if (!isPlainObject(input) || !input.title) {
      return this.send(res, 422, acError("Deal title is required.", "Missing required field `title`.", "title", "/data/attributes/title"));
    }
    if (input.stage !== undefined && !this.dealStages.has(String(input.stage))) {
      return this.send(res, 422, acError("Related Stage not found.", `Stage ${input.stage} does not exist.`, "not_found", "/data/attributes/stage"));
    }
    const id = this._nextId();
    const stage = input.stage ? String(input.stage) : Array.from(this.dealStages.keys())[0];
    const group = input.group ? String(input.group) : (this.dealStages.get(stage) || {}).group || Array.from(this.dealGroups.keys())[0];
    const rec = {
      id,
      title: String(input.title),
      description: input.description || "",
      contact: input.contact ? String(input.contact) : null,
      account: input.account ? String(input.account) : null,
      value: input.value !== undefined ? String(input.value) : "0",
      currency: input.currency || "usd",
      group,
      stage,
      owner: input.owner ? String(input.owner) : "1",
      status: input.status !== undefined ? String(input.status) : "0",
      percent: input.percent !== undefined && input.percent !== null ? String(input.percent) : null,
      fields: Array.isArray(input.fields)
        ? input.fields
            .filter((f) => isPlainObject(f) && f.customFieldId !== undefined)
            .map((f) => {
              const out = { customFieldId: f.customFieldId, fieldValue: f.fieldValue, dealId: id };
              if (f.fieldCurrency !== undefined) out.fieldCurrency = f.fieldCurrency;
              return out;
            })
        : [],
      hash: randomUUID().slice(0, 8),
      cdate: now(),
      mdate: now(),
    };
    this.deals.set(id, rec);
    // The real `POST /deals` wraps the deal alongside the related `contacts` and
    // `dealStages` arrays. Source: create-a-deal-new OpenAPI 201 example
    // (https://developers.activecampaign.com/reference/create-a-deal-new.md).
    const contacts = rec.contact && this.contacts.has(rec.contact)
      ? [this._contactView(this.contacts.get(rec.contact))]
      : [];
    const stageRec = this.dealStages.get(rec.stage);
    const dealStages = stageRec ? [this._dealStageView(stageRec)] : [];
    return this.send(res, 201, { contacts, deal: this._dealView(rec), dealStages });
  }

  _dealView(rec) {
    return {
      id: rec.id,
      title: rec.title,
      description: rec.description,
      contact: rec.contact,
      account: rec.account,
      organization: rec.account,
      customerAccount: rec.account,
      value: rec.value,
      currency: rec.currency,
      group: rec.group,
      stage: rec.stage,
      owner: rec.owner,
      status: rec.status,
      percent: rec.percent !== undefined ? rec.percent : null,
      fields: Array.isArray(rec.fields) ? rec.fields : [],
      hash: rec.hash || "",
      nextdate: null,
      winProbability: null,
      winProbabilityMdate: null,
      isDisabled: false,
      cdate: rec.cdate,
      mdate: rec.mdate,
      links: { contact: this._link(`/api/3/deals/${rec.id}/contact`), stage: this._link(`/api/3/deals/${rec.id}/stage`), group: this._link(`/api/3/deals/${rec.id}/group`), account: this._link(`/api/3/deals/${rec.id}/account`), owner: this._link(`/api/3/deals/${rec.id}/owner`) },
    };
  }

  // =========================================================================
  // Deal Groups (Pipelines)
  // =========================================================================
  routeDealGroups(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.dealGroups, "dealGroups", (g) => this._dealGroupView(g));
      if (req.method === "POST") return this.createDealGroup(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.dealGroups.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { dealGroup: this._dealGroupView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.dealGroups.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.dealGroup) || {};
        for (const k of ["title", "currency"]) if (input[k] !== undefined) rec[k] = String(input[k]);
        rec.udate = now();
        return this.send(res, 200, { dealGroup: this._dealGroupView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.dealGroups.has(id)) return this.send(res, 404, { message: "No Result." });
        this.dealGroups.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createDealGroup(res, body) {
    const input = body && body.dealGroup;
    if (!isPlainObject(input) || !input.title) {
      return this.send(res, 422, acError("Pipeline title is required.", "Missing required field `title`.", "title", "/data/attributes/title"));
    }
    const id = this._nextId();
    const rec = {
      id,
      title: String(input.title),
      currency: input.currency || "usd",
      allgroups: "1",
      allusers: "1",
      autogenerate_id: "0",
      cdate: now(),
      udate: now(),
    };
    this.dealGroups.set(id, rec);
    return this.send(res, 201, { dealGroup: this._dealGroupView(rec) });
  }

  _dealGroupView(rec) {
    return {
      id: rec.id,
      title: rec.title,
      currency: rec.currency,
      allgroups: rec.allgroups,
      allusers: rec.allusers,
      autogenerate_id: rec.autogenerate_id,
      cdate: rec.cdate,
      udate: rec.udate,
      links: { dealStages: this._link(`/api/3/dealGroups/${rec.id}/dealStages`) },
    };
  }

  // =========================================================================
  // Deal Stages
  // =========================================================================
  routeDealStages(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.dealStages, "dealStages", (s) => this._dealStageView(s));
      if (req.method === "POST") return this.createDealStage(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.dealStages.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { dealStage: this._dealStageView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.dealStages.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.dealStage) || {};
        for (const k of ["title", "color"]) if (input[k] !== undefined) rec[k] = String(input[k]);
        if (input.group !== undefined) rec.group = String(input.group);
        rec.udate = now();
        return this.send(res, 200, { dealStage: this._dealStageView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.dealStages.has(id)) return this.send(res, 404, { message: "No Result." });
        this.dealStages.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createDealStage(res, body) {
    const input = body && body.dealStage;
    if (!isPlainObject(input) || !input.title || input.group === undefined) {
      return this.send(res, 422, acError("Stage title and group are required.", "Missing required fields.", "required", "/data/attributes/title"));
    }
    if (!this.dealGroups.has(String(input.group))) {
      return this.send(res, 422, acError("Related Pipeline not found.", `Pipeline ${input.group} does not exist.`, "not_found", "/data/attributes/group"));
    }
    const id = this._nextId();
    const rec = {
      id,
      title: String(input.title),
      group: String(input.group),
      order: input.order ? String(input.order) : "0",
      color: input.color || "008800",
      width: input.width ? String(input.width) : "280",
      dealOrder: input.dealOrder || "next-action ASC",
      cdate: now(),
      udate: now(),
    };
    this.dealStages.set(id, rec);
    return this.send(res, 201, { dealStage: this._dealStageView(rec) });
  }

  _dealStageView(rec) {
    return {
      id: rec.id,
      title: rec.title,
      group: rec.group,
      order: rec.order,
      color: rec.color,
      width: rec.width,
      dealOrder: rec.dealOrder,
      cdate: rec.cdate,
      udate: rec.udate,
      links: { group: this._link(`/api/3/dealStages/${rec.id}/group`) },
    };
  }

  // =========================================================================
  // Notes
  // =========================================================================
  routeNotes(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.notes, "notes", (n) => this._noteView(n));
      if (req.method === "POST") return this.createNote(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.notes.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { note: this._noteView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.notes.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.note) || {};
        if (input.note !== undefined) rec.note = String(input.note);
        rec.mdate = now();
        return this.send(res, 200, { note: this._noteView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.notes.has(id)) return this.send(res, 404, { message: "No Result." });
        this.notes.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createNote(res, body) {
    const input = body && body.note;
    if (!isPlainObject(input) || input.note === undefined) {
      return this.send(res, 422, acError("Note text is required.", "Missing required field `note`.", "note", "/data/attributes/note"));
    }
    const id = this._nextId();
    const rec = {
      id,
      note: String(input.note),
      relid: input.relid ? String(input.relid) : "0",
      reltype: input.reltype || "Subscriber",
      cdate: now(),
      mdate: now(),
    };
    this.notes.set(id, rec);
    return this.send(res, 201, { note: this._noteView(rec) });
  }

  _noteView(rec) {
    return {
      id: rec.id,
      note: rec.note,
      relid: rec.relid,
      reltype: rec.reltype,
      cdate: rec.cdate,
      mdate: rec.mdate,
      links: { user: this._link(`/api/3/notes/${rec.id}/user`) },
    };
  }

  // =========================================================================
  // Accounts (CRM organisations)
  // =========================================================================
  routeAccounts(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.accounts, "accounts", (a) => this._accountView(a));
      if (req.method === "POST") return this.createAccount(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.accounts.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { account: this._accountView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.accounts.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.account) || {};
        for (const k of ["name", "accountUrl"]) if (input[k] !== undefined) rec[k] = String(input[k]);
        rec.updated_timestamp = now();
        return this.send(res, 200, { account: this._accountView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.accounts.has(id)) return this.send(res, 404, { message: "No Result." });
        this.accounts.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createAccount(res, body) {
    const input = body && body.account;
    if (!isPlainObject(input) || !input.name) {
      return this.send(res, 422, acError("Account name is required.", "Missing required field `name`.", "name", "/data/attributes/name"));
    }
    const id = this._nextId();
    const rec = {
      id,
      name: String(input.name),
      accountUrl: input.accountUrl || "",
      created_timestamp: now(),
      updated_timestamp: now(),
    };
    this.accounts.set(id, rec);
    return this.send(res, 201, { account: this._accountView(rec) });
  }

  _accountView(rec) {
    return {
      id: rec.id,
      name: rec.name,
      accountUrl: rec.accountUrl,
      created_timestamp: rec.created_timestamp,
      updated_timestamp: rec.updated_timestamp,
      contactCount: "0",
      dealCount: "0",
      links: { accountContacts: this._link(`/api/3/accounts/${rec.id}/accountContacts`), notes: this._link(`/api/3/accounts/${rec.id}/notes`) },
    };
  }

  // =========================================================================
  // Campaigns (read-only)
  // =========================================================================
  routeCampaigns(req, res, parts, body, url) {
    if (parts.length === 1 && req.method === "GET") {
      return this.listGeneric(res, url, this.campaigns, "campaigns", (c) => this._campaignView(c));
    }
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.campaigns.get(parts[1]);
      if (!rec) return this.send(res, 404, { message: "No Result." });
      return this.send(res, 200, { campaign: this._campaignView(rec) });
    }
    return this.methodNotAllowed(res);
  }

  _campaignView(rec) {
    return { ...rec, links: { links: this._link(`/api/3/campaigns/${rec.id}/links`) } };
  }

  // =========================================================================
  // Automations (read-only)
  // =========================================================================
  routeAutomations(req, res, parts, body, url) {
    if (parts.length === 1 && req.method === "GET") {
      return this.listGeneric(res, url, this.automations, "automations", (a) => this._automationView(a));
    }
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.automations.get(parts[1]);
      if (!rec) return this.send(res, 404, { message: "No Result." });
      return this.send(res, 200, { automation: this._automationView(rec) });
    }
    return this.methodNotAllowed(res);
  }

  _automationView(rec) {
    return { ...rec, links: { contactAutomations: this._link(`/api/3/automations/${rec.id}/contactAutomations`) } };
  }

  // =========================================================================
  // Contact Automations (enrol a contact into an automation)
  // =========================================================================
  routeContactAutomations(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.contactAutomations, "contactAutomations", (ca) => this._contactAutomationView(ca));
      if (req.method === "POST") return this.createContactAutomation(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.contactAutomations.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { contactAutomation: this._contactAutomationView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.contactAutomations.has(id)) return this.send(res, 404, { message: "No Result." });
        this.contactAutomations.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createContactAutomation(res, body) {
    const input = body && body.contactAutomation;
    if (!isPlainObject(input) || input.contact === undefined || input.automation === undefined) {
      return this.send(res, 422, acError("Contact and automation are required.", "Missing required fields.", "required", "/data/attributes/contact"));
    }
    const contact = String(input.contact);
    const automation = String(input.automation);
    if (!this.contacts.has(contact)) {
      return this.send(res, 422, acError("Related Contact not found.", `Contact ${contact} does not exist.`, "not_found", "/data/attributes/contact"));
    }
    if (!this.automations.has(automation)) {
      return this.send(res, 422, acError("Related Automation not found.", `Automation ${automation} does not exist.`, "not_found", "/data/attributes/automation"));
    }
    const id = this._nextId();
    const rec = { id, contact, automation, adddate: now(), status: "1" };
    this.contactAutomations.set(id, rec);
    return this.send(res, 201, { contactAutomation: this._contactAutomationView(rec) });
  }

  _contactAutomationView(rec) {
    return {
      id: rec.id,
      contact: rec.contact,
      automation: rec.automation,
      adddate: rec.adddate,
      status: rec.status,
      completed: "0",
      completedElements: "0",
      totalElements: "0",
      links: { automation: this._link(`/api/3/contactAutomations/${rec.id}/automation`), contact: this._link(`/api/3/contactAutomations/${rec.id}/contact`) },
    };
  }

  // =========================================================================
  // Segments (read-only)
  // =========================================================================
  routeSegments(req, res, parts, body, url) {
    if (parts.length === 1 && req.method === "GET") {
      return this.listGeneric(res, url, this.segments, "segments", (s) => this._segmentView(s));
    }
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.segments.get(parts[1]);
      if (!rec) return this.send(res, 404, { message: "No Result." });
      return this.send(res, 200, { segment: this._segmentView(rec) });
    }
    return this.methodNotAllowed(res);
  }

  _segmentView(rec) {
    return { ...rec, links: { lists: this._link(`/api/3/segments/${rec.id}/lists`) } };
  }

  // =========================================================================
  // Users (read-only)
  // =========================================================================
  routeUsers(req, res, parts, body, url) {
    if (parts.length === 1 && req.method === "GET") {
      return this.listGeneric(res, url, this.users, "users", (u) => this._userView(u));
    }
    if (parts.length === 2 && req.method === "GET") {
      const rec = this.users.get(parts[1]);
      if (!rec) return this.send(res, 404, { message: "No Result." });
      return this.send(res, 200, { user: this._userView(rec) });
    }
    return this.methodNotAllowed(res);
  }

  _userView(rec) {
    return { ...rec, links: { lists: this._link(`/api/3/users/${rec.id}/lists`) } };
  }

  // =========================================================================
  // Webhooks
  // =========================================================================
  routeWebhooks(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listGeneric(res, url, this.webhooks, "webhooks", (w) => this._webhookView(w));
      if (req.method === "POST") return this.createWebhook(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (req.method === "GET") {
        const rec = this.webhooks.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        return this.send(res, 200, { webhook: this._webhookView(rec) });
      }
      if (req.method === "PUT") {
        const rec = this.webhooks.get(id);
        if (!rec) return this.send(res, 404, { message: "No Result." });
        const input = (body && body.webhook) || {};
        for (const k of ["name", "url"]) if (input[k] !== undefined) rec[k] = String(input[k]);
        if (Array.isArray(input.events)) rec.events = input.events.map(String);
        return this.send(res, 200, { webhook: this._webhookView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this.webhooks.has(id)) return this.send(res, 404, { message: "No Result." });
        this.webhooks.delete(id);
        return this.send(res, 200, {});
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { message: "No Result." });
  }

  createWebhook(res, body) {
    const input = body && body.webhook;
    if (!isPlainObject(input) || !input.name || !input.url) {
      return this.send(res, 422, acError("Webhook name and url are required.", "Missing required fields.", "required", "/data/attributes/name"));
    }
    const id = this._nextId();
    const rec = {
      id,
      name: String(input.name),
      url: String(input.url),
      events: Array.isArray(input.events) ? input.events.map(String) : [],
      sources: Array.isArray(input.sources) ? input.sources.map(String) : ["public", "admin", "api", "system"],
      cdate: now(),
    };
    this.webhooks.set(id, rec);
    return this.send(res, 201, { webhook: this._webhookView(rec) });
  }

  _webhookView(rec) {
    return {
      id: rec.id,
      name: rec.name,
      url: rec.url,
      events: rec.events,
      sources: rec.sources,
      cdate: rec.cdate,
      links: { listEvents: this._link(`/api/3/webhooks/${rec.id}/listEvents`) },
    };
  }

  // =========================================================================
  // Generic list helper (pagination + plural envelope + meta.total)
  // =========================================================================
  listGeneric(res, url, map, pluralKey, view) {
    const all = Array.from(map.values());
    const total = all.length;
    const { offset, limit } = this._paginate(url);
    const page = all.slice(offset, offset + limit);
    return this.send(res, 200, { [pluralKey]: page.map(view), meta: { total: String(total) } });
  }

  _paginate(url) {
    let limit = parseInt(url.searchParams.get("limit"), 10);
    let offset = parseInt(url.searchParams.get("offset"), 10);
    if (!Number.isInteger(limit) || limit <= 0) limit = 20;
    if (limit > 100) limit = 100;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    return { offset, limit };
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
        contacts: this.contacts.size,
        tags: this.tags.size,
        contactTags: this.contactTags.size,
        lists: this.lists.size,
        contactLists: this.contactLists.size,
        fields: this.fields.size,
        fieldValues: this.fieldValues.size,
        deals: this.deals.size,
        dealGroups: this.dealGroups.size,
        dealStages: this.dealStages.size,
        notes: this.notes.size,
        accounts: this.accounts.size,
        campaigns: this.campaigns.size,
        automations: this.automations.size,
        contactAutomations: this.contactAutomations.size,
        segments: this.segments.size,
        users: this.users.size,
        webhooks: this.webhooks.size,
      });
    }
    return this.send(res, 404, { message: "No Result." });
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const token = req.headers["api-token"];
    return typeof token === "string" && token.length > 0;
  }

  methodNotAllowed(res) {
    return this.send(res, 405, { message: "Method not allowed." });
  }

  _link(path) {
    return `http://${this.host}:${this.port}${path}`;
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
          this.send(res, 400, { message: "Invalid JSON in request body." });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Error reading request body." });
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
  const port = Number(process.env.PORT || process.env.ACTIVECAMPAIGN_PORT || 4659);
  const server = new ActivecampaignServer(port);
  server.start().then(() => {
    // eslint-disable-next-line no-console
    console.log(`parlel/activecampaign listening on http://127.0.0.1:${port}`);
  });
}

export default ActivecampaignServer;
