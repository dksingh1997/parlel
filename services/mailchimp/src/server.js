import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mailchimp — a tiny, dependency-free fake of the Mailchimp Marketing
// REST API (API 3.0).
//
// It speaks the exact wire protocol used by the official
// `@mailchimp/mailchimp_marketing` Node.js client (and the language-agnostic
// REST API) so application code and AI agents can run against it with zero
// cost and zero side effects. State is in-memory and ephemeral and resettable.
//
// The official client prefixes every path with `/3.0` and authenticates with
// HTTP Basic auth (`Authorization: Basic base64("anystring:apikey")`) — though
// it also accepts an OAuth2 Bearer token. Both are accepted here.
//
// Implemented surface (grouped, mirrors the client namespaces):
//   root.getRoot                                GET    /
//   ping.get                                    GET    /ping
//   lists.*           (Lists/Audiences)         /lists, /lists/{id}, members,
//                                                merge-fields, segments, tags,
//                                                webhooks, interest-categories,
//                                                interests, notes, events,
//                                                growth-history, activity,
//                                                signup-forms, abuse-reports,
//                                                clients, locations, tag-search
//   campaigns.*       (Campaigns)               /campaigns + actions + content
//   campaignFolders.* (Campaign Folders)        /campaign-folders
//   templates.*       (Templates)               /templates
//   templateFolders.* (Template Folders)        /template-folders
//   reports.*         (Reports)                 /reports
//   ecommerce.*       (E-commerce Stores)       /ecommerce/stores + products +
//                                                customers + orders + carts
//   fileManager.*     (File Manager)            /file-manager/files + folders
//   verifiedDomains.* (Verified Domains)        /verified-domains
//   batches.*         (Batch Operations)        /batches
//   searchCampaigns.search                      GET    /search-campaigns
//   searchMembers.search                        GET    /search-members
//
// Plus parlel control/inspection endpoints under /__parlel.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newId(len = 10) {
  return randomUUID().replace(/-/g, "").slice(0, len);
}

// Mailchimp identifies list members by the MD5 hash of the lowercased email.
function subscriberHash(email) {
  return createHash("md5").update(String(email).toLowerCase()).digest("hex");
}

// Mailchimp error envelope follows RFC 7807 "problem+json":
//   { type, title, status, detail, instance, errors? }
function mcError(status, title, detail, errors) {
  const body = {
    type: `https://mailchimp.com/developer/marketing/docs/errors/`,
    title,
    status,
    detail,
    instance: randomUUID(),
  };
  if (errors) body.errors = errors;
  return body;
}

export class MailchimpServer {
  constructor(port = 4653, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.lists = new Map(); // listId -> list record
    this.members = new Map(); // listId -> Map(subscriberHash -> member)
    this.mergeFields = new Map(); // listId -> Map(mergeId -> field)
    this.mergeFieldSeq = new Map(); // listId -> next numeric merge id
    this.segments = new Map(); // listId -> Map(segmentId -> segment)
    this.segmentSeq = new Map();
    this.interestCategories = new Map(); // listId -> Map(catId -> cat)
    this.interests = new Map(); // catId -> Map(interestId -> interest)
    this.webhooks = new Map(); // listId -> Map(webhookId -> webhook)
    this.notes = new Map(); // `${listId}:${hash}` -> Map(noteId -> note)
    this.noteSeq = 0;
    this.campaigns = new Map();
    this.campaignContent = new Map(); // campaignId -> content
    this.campaignFolders = new Map();
    this.templates = new Map();
    this.templateFolders = new Map();
    this.stores = new Map();
    this.products = new Map(); // storeId -> Map(productId -> product)
    this.customers = new Map(); // storeId -> Map(customerId -> customer)
    this.orders = new Map(); // storeId -> Map(orderId -> order)
    this.carts = new Map(); // storeId -> Map(cartId -> cart)
    this.files = new Map();
    this.fileFolders = new Map();
    this.fileFolderSeq = 0;
    this.fileSeq = 0;
    this.verifiedDomains = new Map(); // domainName -> record
    this.batches = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, mcError(500, "Internal Server Error", error.message || "An unexpected error occurred."));
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
    let parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-mailchimp");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Unauthenticated infrastructure endpoints.
    if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return this.send(res, 200, { status: "ok" });
    }

    // parlel inspection / control endpoints.
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // The official client prefixes every request with `/3.0`. Strip it so the
    // routing below works whether or not the prefix is present.
    if (parts[0] === "3.0") parts = parts.slice(1);

    // Root + ping are reachable; everything still needs auth in real life,
    // but ping/root are commonly called right after configuring the client.
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        type: "https://mailchimp.com/developer/marketing/docs/errors/",
        title: "API Key Invalid",
        status: 401,
        detail: "Your API key may be invalid, or you've attempted to access the wrong datacenter.",
        instance: randomUUID(),
      });
    }

    try {
      const head = parts[0];
      if (parts.length === 0) return this.send(res, 200, this.getRoot());
      switch (head) {
        case "ping":
          return this.send(res, 200, { health_status: "Everything's Chimpy!" });
        case "lists":
          return this.routeLists(req, res, parts, body, url);
        case "campaigns":
          return this.routeCampaigns(req, res, parts, body);
        case "campaign-folders":
          return this.routeFolders(req, res, parts, body, this.campaignFolders, "campaign");
        case "templates":
          return this.routeTemplates(req, res, parts, body);
        case "template-folders":
          return this.routeFolders(req, res, parts, body, this.templateFolders, "template");
        case "reports":
          return this.routeReports(req, res, parts, body);
        case "ecommerce":
          return this.routeEcommerce(req, res, parts, body);
        case "file-manager":
          return this.routeFileManager(req, res, parts, body);
        case "verified-domains":
          return this.routeVerifiedDomains(req, res, parts, body);
        case "batches":
          return this.routeBatches(req, res, parts, body);
        case "search-campaigns":
          return this.send(res, 200, { results: { campaigns: [], total_items: 0 }, _links: [] });
        case "search-members":
          return this.searchMembers(res, url);
        default:
          return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
      }
    } catch (error) {
      return this.send(res, 500, mcError(500, "Internal Server Error", error.message || "An unexpected error occurred."));
    }
  }

  getRoot() {
    return {
      account_id: "parlel0000000000000000000",
      login_id: "parlel",
      account_name: "Parlel Test Account",
      email: "dev@parlel.test",
      role: "owner",
      contact: { company: "parlel", addr1: "1 Test St", city: "Testville", state: "CA", zip: "00000", country: "US" },
      pro_enabled: false,
      total_subscribers: this._totalSubscribers(),
      _links: [],
    };
  }

  _totalSubscribers() {
    let total = 0;
    for (const bucket of this.members.values()) total += bucket.size;
    return total;
  }

  // =========================================================================
  // Lists / Audiences
  // =========================================================================
  routeLists(req, res, parts, body, url) {
    // /lists
    if (parts.length === 1) {
      if (req.method === "GET") return this.listLists(res, url);
      if (req.method === "POST") return this.createList(res, body);
      return this.methodNotAllowed(res);
    }

    const listId = parts[1];

    // /lists/{id}  (also POST = batchListMembers)
    if (parts.length === 2) {
      if (req.method === "GET") return this.getList(res, listId);
      if (req.method === "PATCH") return this.updateList(res, listId, body);
      if (req.method === "DELETE") return this.deleteList(res, listId);
      if (req.method === "POST") return this.batchListMembers(res, listId, body);
      return this.methodNotAllowed(res);
    }

    if (!this.lists.has(listId)) {
      return this.send(res, 404, mcError(404, "Resource Not Found", "The requested list could not be found."));
    }

    const sub = parts[2];
    switch (sub) {
      case "members":
        return this.routeMembers(req, res, parts, body, listId, url);
      case "merge-fields":
        return this.routeMergeFields(req, res, parts, body, listId);
      case "segments":
        return this.routeSegments(req, res, parts, body, listId);
      case "interest-categories":
        return this.routeInterestCategories(req, res, parts, body, listId);
      case "webhooks":
        return this.routeWebhooks(req, res, parts, body, listId);
      case "tag-search":
        return this.send(res, 200, { tags: [], total_items: 0 });
      case "growth-history":
        if (parts.length === 4) {
          return this.send(res, 200, { list_id: listId, month: parts[3], existing: 0, imports: 0, optins: 0 });
        }
        return this.send(res, 200, { list_id: listId, history: [], total_items: 0 });
      case "activity":
        return this.send(res, 200, { list_id: listId, activity: [], total_items: 0 });
      case "clients":
        return this.send(res, 200, { list_id: listId, clients: [], total_items: 0 });
      case "locations":
        return this.send(res, 200, { list_id: listId, locations: [], total_items: 0 });
      case "abuse-reports":
        if (parts.length === 4) {
          return this.send(res, 404, mcError(404, "Resource Not Found", "Abuse report not found."));
        }
        return this.send(res, 200, { list_id: listId, abuse_reports: [], total_items: 0 });
      case "signup-forms":
        if (req.method === "POST") return this.send(res, 200, { header: {}, contents: [], styles: [], signup_form_url: `https://parlel.test/subscribe/${listId}` });
        return this.send(res, 200, []);
      default:
        return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
    }
  }

  listLists(res, url) {
    const data = Array.from(this.lists.values()).map((l) => this._listView(l));
    const offset = Number(url.searchParams.get("offset") || 0);
    const count = url.searchParams.get("count") != null ? Number(url.searchParams.get("count")) : data.length;
    return this.send(res, 200, {
      lists: data.slice(offset, offset + count),
      total_items: data.length,
      _links: [],
    });
  }

  createList(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 400, this._invalidResource("name", "Schema describes string, NULL found."));
    }
    const id = newId();
    const record = {
      id,
      web_id: Math.floor(Math.random() * 1e6),
      name: body.name,
      contact: body.contact || {},
      permission_reminder: body.permission_reminder || "",
      use_archive_bar: body.use_archive_bar ?? true,
      campaign_defaults: body.campaign_defaults || {},
      notify_on_subscribe: body.notify_on_subscribe || "",
      notify_on_unsubscribe: body.notify_on_unsubscribe || "",
      date_created: now(),
      list_rating: 0,
      email_type_option: Boolean(body.email_type_option),
      subscribe_url_short: `https://parlel.test/sub/${id}`,
      subscribe_url_long: `https://parlel.test/subscribe?u=${id}`,
      beamer_address: `parlel-${id}@inbound.parlel.test`,
      visibility: body.visibility || "pub",
      double_optin: Boolean(body.double_optin),
      has_welcome: false,
      marketing_permissions: Boolean(body.marketing_permissions),
      stats: {
        member_count: 0,
        unsubscribe_count: 0,
        cleaned_count: 0,
        member_count_since_send: 0,
        unsubscribe_count_since_send: 0,
        cleaned_count_since_send: 0,
        campaign_count: 0,
        merge_field_count: 0,
        avg_sub_rate: 0,
        avg_unsub_rate: 0,
        target_sub_rate: 0,
        open_rate: 0,
        click_rate: 0,
      },
    };
    this.lists.set(id, record);
    this.members.set(id, new Map());
    this.mergeFields.set(id, new Map());
    this.mergeFieldSeq.set(id, 1);
    this.segments.set(id, new Map());
    this.segmentSeq.set(id, 1);
    this.interestCategories.set(id, new Map());
    this.webhooks.set(id, new Map());
    return this.send(res, 200, this._listView(record));
  }

  getList(res, listId) {
    const record = this.lists.get(listId);
    if (!record) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested list could not be found."));
    return this.send(res, 200, this._listView(record));
  }

  updateList(res, listId, body) {
    const record = this.lists.get(listId);
    if (!record) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested list could not be found."));
    if (isPlainObject(body)) {
      for (const key of ["name", "permission_reminder", "notify_on_subscribe", "notify_on_unsubscribe", "visibility"]) {
        if (typeof body[key] === "string") record[key] = body[key];
      }
      if (isPlainObject(body.contact)) record.contact = body.contact;
      if (isPlainObject(body.campaign_defaults)) record.campaign_defaults = body.campaign_defaults;
      if (typeof body.email_type_option === "boolean") record.email_type_option = body.email_type_option;
      if (typeof body.double_optin === "boolean") record.double_optin = body.double_optin;
    }
    return this.send(res, 200, this._listView(record));
  }

  deleteList(res, listId) {
    if (!this.lists.has(listId)) {
      return this.send(res, 404, mcError(404, "Resource Not Found", "The requested list could not be found."));
    }
    this.lists.delete(listId);
    this.members.delete(listId);
    this.mergeFields.delete(listId);
    this.segments.delete(listId);
    this.interestCategories.delete(listId);
    this.webhooks.delete(listId);
    return this.send(res, 204, null);
  }

  _listView(record) {
    const view = clone(record);
    view.stats = { ...view.stats, member_count: (this.members.get(record.id)?.size) || 0 };
    view._links = [];
    return view;
  }

  batchListMembers(res, listId, body) {
    const list = this.lists.get(listId);
    if (!list) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested list could not be found."));
    const members = Array.isArray(body?.members) ? body.members : [];
    const created = [];
    const updated = [];
    const errors = [];
    const bucket = this.members.get(listId);
    for (const m of members) {
      if (!isPlainObject(m) || typeof m.email_address !== "string" || !EMAIL_RE.test(m.email_address)) {
        errors.push({ email_address: m?.email_address ?? null, error: "Invalid email address.", error_code: "ERROR_CONTACT_EXISTS" });
        continue;
      }
      const hash = subscriberHash(m.email_address);
      const existed = bucket.has(hash);
      const rec = this._upsertMember(listId, m.email_address, m);
      if (existed) updated.push(rec);
      else created.push(rec);
    }
    return this.send(res, 200, {
      new_members: created,
      updated_members: updated,
      errors,
      total_created: created.length,
      total_updated: updated.length,
      error_count: errors.length,
    });
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------
  routeMembers(req, res, parts, body, listId, url) {
    const bucket = this.members.get(listId);

    // /lists/{id}/members
    if (parts.length === 3) {
      if (req.method === "GET") return this.listMembers(res, listId, url);
      if (req.method === "POST") return this.addMember(res, listId, body);
      return this.methodNotAllowed(res);
    }

    const hash = parts[3];

    // /lists/{id}/members/{hash}
    if (parts.length === 4) {
      if (req.method === "GET") {
        const m = bucket.get(hash);
        if (!m) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
        return this.send(res, 200, clone(m));
      }
      if (req.method === "PUT") return this.setMember(res, listId, hash, body);
      if (req.method === "PATCH") return this.updateMember(res, listId, hash, body);
      if (req.method === "DELETE") {
        if (!bucket.has(hash)) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
        bucket.delete(hash);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }

    // /lists/{id}/members/{hash}/<sub>
    const member = bucket.get(hash);
    const sub = parts[4];
    if (parts.length >= 5) {
      if (sub === "tags") {
        if (!member) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
        if (req.method === "GET") return this.send(res, 200, { tags: member.tags.map((t) => ({ id: subscriberHash(t.name).slice(0, 6), name: t.name })), total_items: member.tags.length });
        if (req.method === "POST") return this.updateMemberTags(res, member, body);
        return this.methodNotAllowed(res);
      }
      if (sub === "notes") {
        return this.routeMemberNotes(req, res, parts, body, listId, hash);
      }
      if (sub === "events") {
        if (!member) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
        if (req.method === "POST") return this.send(res, 204, null);
        return this.send(res, 200, { events: [], total_items: 0 });
      }
      if (sub === "activity") {
        return this.send(res, 200, { activity: [], email_id: hash, list_id: listId, total_items: 0 });
      }
      if (sub === "activity-feed") {
        return this.send(res, 200, { activity: [], email_id: hash, list_id: listId, total_items: 0 });
      }
      if (sub === "goals") {
        return this.send(res, 200, { goals: [], email_id: hash, list_id: listId, total_items: 0 });
      }
      if (sub === "actions" && parts[5] === "delete-permanent") {
        if (!bucket.has(hash)) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
        bucket.delete(hash);
        return this.send(res, 204, null);
      }
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
  }

  listMembers(res, listId, url) {
    const bucket = this.members.get(listId);
    let data = Array.from(bucket.values());
    const status = url.searchParams.get("status");
    if (status) data = data.filter((m) => m.status === status);
    const offset = Number(url.searchParams.get("offset") || 0);
    const count = url.searchParams.get("count") != null ? Number(url.searchParams.get("count")) : data.length;
    return this.send(res, 200, {
      members: data.slice(offset, offset + count).map(clone),
      list_id: listId,
      total_items: data.length,
      _links: [],
    });
  }

  addMember(res, listId, body) {
    if (!isPlainObject(body) || typeof body.email_address !== "string" || !EMAIL_RE.test(body.email_address)) {
      return this.send(res, 400, this._invalidResource("email_address", "Please provide a valid email address."));
    }
    const validStatuses = ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"];
    if (!validStatuses.includes(body.status)) {
      return this.send(res, 400, this._invalidResource("status", "The resource submitted could not be validated."));
    }
    const hash = subscriberHash(body.email_address);
    const bucket = this.members.get(listId);
    if (bucket.has(hash)) {
      return this.send(res, 400, {
        type: "https://mailchimp.com/developer/marketing/docs/errors/",
        title: "Member Exists",
        status: 400,
        detail: `${body.email_address} is already a list member. Use PUT to insert or update list members.`,
        instance: randomUUID(),
      });
    }
    const rec = this._upsertMember(listId, body.email_address, body);
    return this.send(res, 200, clone(rec));
  }

  setMember(res, listId, hash, body) {
    if (!isPlainObject(body) || typeof body.email_address !== "string" || !EMAIL_RE.test(body.email_address)) {
      return this.send(res, 400, this._invalidResource("email_address", "Please provide a valid email address."));
    }
    const validStatuses = ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"];
    const bucket = this.members.get(listId);
    const existing = bucket.get(hash);
    if (!existing && !validStatuses.includes(body.status_if_new) && !validStatuses.includes(body.status)) {
      return this.send(res, 400, this._invalidResource("status", "The resource submitted could not be validated."));
    }
    const payload = { ...body };
    if (!existing && body.status === undefined && body.status_if_new) payload.status = body.status_if_new;
    const rec = this._upsertMember(listId, body.email_address, payload);
    return this.send(res, 200, clone(rec));
  }

  updateMember(res, listId, hash, body) {
    const bucket = this.members.get(listId);
    const existing = bucket.get(hash);
    if (!existing) return this.send(res, 404, mcError(404, "Resource Not Found", "The requested resource could not be found."));
    if (isPlainObject(body)) {
      if (typeof body.status === "string") existing.status = body.status;
      if (typeof body.email_type === "string") existing.email_type = body.email_type;
      if (isPlainObject(body.merge_fields)) existing.merge_fields = { ...existing.merge_fields, ...body.merge_fields };
      if (isPlainObject(body.interests)) existing.interests = { ...existing.interests, ...body.interests };
      existing.last_changed = now();
    }
    return this.send(res, 200, clone(existing));
  }

  _upsertMember(listId, email, body) {
    const bucket = this.members.get(listId);
    const hash = subscriberHash(email);
    let rec = bucket.get(hash);
    if (!rec) {
      rec = {
        id: hash,
        email_address: email,
        unique_email_id: newId(8),
        contact_id: newId(16),
        full_name: "",
        web_id: Math.floor(Math.random() * 1e6),
        email_type: body.email_type || "html",
        status: body.status || body.status_if_new || "subscribed",
        merge_fields: isPlainObject(body.merge_fields) ? body.merge_fields : {},
        interests: isPlainObject(body.interests) ? body.interests : {},
        stats: { avg_open_rate: 0, avg_click_rate: 0 },
        ip_signup: "",
        timestamp_signup: "",
        ip_opt: "",
        timestamp_opt: now(),
        member_rating: 2,
        last_changed: now(),
        language: body.language || "",
        vip: Boolean(body.vip),
        email_client: "",
        location: { latitude: 0, longitude: 0, gmtoff: 0, dstoff: 0, country_code: "", timezone: "", region: "" },
        source: "API - Generic",
        tags_count: 0,
        tags: [],
        list_id: listId,
      };
      bucket.set(hash, rec);
    } else {
      if (typeof body.status === "string") rec.status = body.status;
      if (typeof body.email_type === "string") rec.email_type = body.email_type;
      if (isPlainObject(body.merge_fields)) rec.merge_fields = { ...rec.merge_fields, ...body.merge_fields };
      if (isPlainObject(body.interests)) rec.interests = { ...rec.interests, ...body.interests };
      rec.last_changed = now();
    }
    const fn = rec.merge_fields.FNAME || "";
    const ln = rec.merge_fields.LNAME || "";
    rec.full_name = `${fn} ${ln}`.trim();
    if (Array.isArray(body.tags)) {
      for (const t of body.tags) {
        const name = typeof t === "string" ? t : t?.name;
        if (name && !rec.tags.some((x) => x.name === name)) rec.tags.push({ id: subscriberHash(name).slice(0, 6), name });
      }
      rec.tags_count = rec.tags.length;
    }
    return rec;
  }

  updateMemberTags(res, member, body) {
    const tags = Array.isArray(body?.tags) ? body.tags : [];
    for (const t of tags) {
      const name = t?.name;
      if (!name) continue;
      if (t.status === "active") {
        if (!member.tags.some((x) => x.name === name)) member.tags.push({ id: subscriberHash(name).slice(0, 6), name });
      } else if (t.status === "inactive") {
        member.tags = member.tags.filter((x) => x.name !== name);
      }
    }
    member.tags_count = member.tags.length;
    return this.send(res, 204, null);
  }

  routeMemberNotes(req, res, parts, body, listId, hash) {
    const key = `${listId}:${hash}`;
    if (!this.notes.has(key)) this.notes.set(key, new Map());
    const bucket = this.notes.get(key);
    // /lists/{id}/members/{hash}/notes
    if (parts.length === 5) {
      if (req.method === "GET") {
        return this.send(res, 200, { notes: Array.from(bucket.values()).map(clone), email_id: hash, list_id: listId, total_items: bucket.size });
      }
      if (req.method === "POST") {
        const id = String(++this.noteSeq);
        const rec = { id, created_at: now(), created_by: "parlel", updated_at: now(), note: body?.note || "", list_id: listId, email_id: hash };
        bucket.set(id, rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    // /lists/{id}/members/{hash}/notes/{noteId}
    if (parts.length === 6) {
      const noteId = parts[5];
      const rec = bucket.get(noteId);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Note not found."));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Note not found."));
        if (body?.note != null) rec.note = body.note;
        rec.updated_at = now();
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Note not found."));
        bucket.delete(noteId);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // -------------------------------------------------------------------------
  // Merge fields
  // -------------------------------------------------------------------------
  routeMergeFields(req, res, parts, body, listId) {
    const bucket = this.mergeFields.get(listId);
    if (parts.length === 3) {
      if (req.method === "GET") return this.send(res, 200, { merge_fields: Array.from(bucket.values()).map(clone), list_id: listId, total_items: bucket.size });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.name || !body.type) {
          return this.send(res, 400, this._invalidResource("name", "Merge field requires name and type."));
        }
        const seq = this.mergeFieldSeq.get(listId);
        this.mergeFieldSeq.set(listId, seq + 1);
        const tag = body.tag || `MMERGE${seq}`;
        const rec = {
          merge_id: seq,
          tag,
          name: body.name,
          type: body.type,
          required: Boolean(body.required),
          default_value: body.default_value || "",
          public: body.public ?? true,
          display_order: seq,
          options: body.options || {},
          help_text: body.help_text || "",
          list_id: listId,
        };
        bucket.set(String(seq), rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 4) {
      const id = parts[3];
      const rec = bucket.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Merge field not found."));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Merge field not found."));
        for (const k of ["name", "default_value", "help_text"]) if (typeof body[k] === "string") rec[k] = body[k];
        if (typeof body.required === "boolean") rec.required = body.required;
        if (typeof body.public === "boolean") rec.public = body.public;
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Merge field not found."));
        bucket.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // -------------------------------------------------------------------------
  // Segments
  // -------------------------------------------------------------------------
  routeSegments(req, res, parts, body, listId) {
    const bucket = this.segments.get(listId);
    if (parts.length === 3) {
      if (req.method === "GET") return this.send(res, 200, { segments: Array.from(bucket.values()).map(clone), list_id: listId, total_items: bucket.size });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.name) return this.send(res, 400, this._invalidResource("name", "Segment requires a name."));
        const seq = this.segmentSeq.get(listId);
        this.segmentSeq.set(listId, seq + 1);
        const members = Array.isArray(body.static_segment) ? body.static_segment : [];
        const rec = {
          id: seq,
          name: body.name,
          member_count: members.length,
          type: body.options ? "saved" : "static",
          created_at: now(),
          updated_at: now(),
          options: body.options || {},
          list_id: listId,
          _members: members,
        };
        bucket.set(String(seq), rec);
        return this.send(res, 200, this._segmentView(rec));
      }
      return this.methodNotAllowed(res);
    }
    const id = parts[3];
    const rec = bucket.get(id);
    if (parts.length === 4) {
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Segment not found."));
        return this.send(res, 200, this._segmentView(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Segment not found."));
        if (typeof body.name === "string") rec.name = body.name;
        if (Array.isArray(body.static_segment)) { rec._members = body.static_segment; rec.member_count = body.static_segment.length; }
        rec.updated_at = now();
        return this.send(res, 200, this._segmentView(rec));
      }
      if (req.method === "POST") {
        // batchSegmentMembers
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Segment not found."));
        const add = Array.isArray(body.members_to_add) ? body.members_to_add : [];
        const remove = Array.isArray(body.members_to_remove) ? body.members_to_remove : [];
        for (const e of add) if (!rec._members.includes(e)) rec._members.push(e);
        rec._members = rec._members.filter((e) => !remove.includes(e));
        rec.member_count = rec._members.length;
        return this.send(res, 200, {
          members_added: add.map((e) => ({ email_address: e, id: subscriberHash(e) })),
          members_removed: remove.map((e) => ({ email_address: e, id: subscriberHash(e) })),
          errors: [],
          total_added: add.length,
          total_removed: remove.length,
          error_count: 0,
        });
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Segment not found."));
        bucket.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    // /segments/{id}/members
    if (parts.length >= 5 && parts[4] === "members") {
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Segment not found."));
      if (parts.length === 5) {
        if (req.method === "GET") {
          const bucketM = this.members.get(listId);
          const members = rec._members.map((e) => bucketM.get(subscriberHash(e))).filter(Boolean).map(clone);
          return this.send(res, 200, { members, total_items: members.length });
        }
        if (req.method === "POST") {
          if (!body?.email_address) return this.send(res, 400, this._invalidResource("email_address", "Email required."));
          if (!rec._members.includes(body.email_address)) rec._members.push(body.email_address);
          rec.member_count = rec._members.length;
          return this.send(res, 200, { id: subscriberHash(body.email_address), email_address: body.email_address, list_id: listId });
        }
      }
      if (parts.length === 6 && req.method === "DELETE") {
        const hash = parts[5];
        const bucketM = this.members.get(listId);
        const m = bucketM.get(hash);
        if (m) rec._members = rec._members.filter((e) => e !== m.email_address);
        rec.member_count = rec._members.length;
        return this.send(res, 204, null);
      }
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  _segmentView(rec) {
    const view = clone(rec);
    delete view._members;
    return view;
  }

  // -------------------------------------------------------------------------
  // Interest categories + interests
  // -------------------------------------------------------------------------
  routeInterestCategories(req, res, parts, body, listId) {
    const bucket = this.interestCategories.get(listId);
    if (parts.length === 3) {
      if (req.method === "GET") return this.send(res, 200, { categories: Array.from(bucket.values()).map(clone), list_id: listId, total_items: bucket.size });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.title || !body.type) return this.send(res, 400, this._invalidResource("title", "Category requires title and type."));
        const id = newId();
        const rec = { id, list_id: listId, title: body.title, display_order: body.display_order || 0, type: body.type };
        bucket.set(id, rec);
        this.interests.set(id, new Map());
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    const catId = parts[3];
    const cat = bucket.get(catId);
    if (parts.length === 4) {
      if (req.method === "GET") {
        if (!cat) return this.send(res, 404, mcError(404, "Resource Not Found", "Category not found."));
        return this.send(res, 200, clone(cat));
      }
      if (req.method === "PATCH") {
        if (!cat) return this.send(res, 404, mcError(404, "Resource Not Found", "Category not found."));
        if (typeof body.title === "string") cat.title = body.title;
        if (typeof body.type === "string") cat.type = body.type;
        return this.send(res, 200, clone(cat));
      }
      if (req.method === "DELETE") {
        if (!cat) return this.send(res, 404, mcError(404, "Resource Not Found", "Category not found."));
        bucket.delete(catId);
        this.interests.delete(catId);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    // /interest-categories/{catId}/interests
    if (parts.length >= 5 && parts[4] === "interests") {
      if (!cat) return this.send(res, 404, mcError(404, "Resource Not Found", "Category not found."));
      if (!this.interests.has(catId)) this.interests.set(catId, new Map());
      const ibucket = this.interests.get(catId);
      if (parts.length === 5) {
        if (req.method === "GET") return this.send(res, 200, { interests: Array.from(ibucket.values()).map(clone), list_id: listId, category_id: catId, total_items: ibucket.size });
        if (req.method === "POST") {
          if (!body?.name) return this.send(res, 400, this._invalidResource("name", "Interest requires a name."));
          const id = newId();
          const rec = { id, category_id: catId, list_id: listId, name: body.name, subscriber_count: "0", display_order: body.display_order || 0 };
          ibucket.set(id, rec);
          return this.send(res, 200, clone(rec));
        }
      }
      if (parts.length === 6) {
        const iid = parts[5];
        const irec = ibucket.get(iid);
        if (req.method === "GET") {
          if (!irec) return this.send(res, 404, mcError(404, "Resource Not Found", "Interest not found."));
          return this.send(res, 200, clone(irec));
        }
        if (req.method === "PATCH") {
          if (!irec) return this.send(res, 404, mcError(404, "Resource Not Found", "Interest not found."));
          if (typeof body.name === "string") irec.name = body.name;
          return this.send(res, 200, clone(irec));
        }
        if (req.method === "DELETE") {
          if (!irec) return this.send(res, 404, mcError(404, "Resource Not Found", "Interest not found."));
          ibucket.delete(iid);
          return this.send(res, 204, null);
        }
      }
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  routeWebhooks(req, res, parts, body, listId) {
    const bucket = this.webhooks.get(listId);
    if (parts.length === 3) {
      if (req.method === "GET") return this.send(res, 200, { webhooks: Array.from(bucket.values()).map(clone), list_id: listId, total_items: bucket.size });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.url) return this.send(res, 400, this._invalidResource("url", "Webhook requires a url."));
        const id = newId();
        const rec = {
          id,
          url: body.url,
          events: body.events || { subscribe: false, unsubscribe: false, profile: false, cleaned: false, upemail: false, campaign: false },
          sources: body.sources || { user: false, admin: false, api: false },
          list_id: listId,
        };
        bucket.set(id, rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 4) {
      const id = parts[3];
      const rec = bucket.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Webhook not found."));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Webhook not found."));
        if (typeof body.url === "string") rec.url = body.url;
        if (isPlainObject(body.events)) rec.events = { ...rec.events, ...body.events };
        if (isPlainObject(body.sources)) rec.sources = { ...rec.sources, ...body.sources };
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Webhook not found."));
        bucket.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Campaigns
  // =========================================================================
  routeCampaigns(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, { campaigns: Array.from(this.campaigns.values()).map(clone), total_items: this.campaigns.size, _links: [] });
      if (req.method === "POST") return this.createCampaign(res, body);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    const rec = this.campaigns.get(id);
    if (parts.length === 2) {
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
        if (isPlainObject(body?.settings)) rec.settings = { ...rec.settings, ...body.settings };
        if (isPlainObject(body?.recipients)) rec.recipients = { ...rec.recipients, ...body.recipients };
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
        this.campaigns.delete(id);
        this.campaignContent.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    // /campaigns/{id}/content
    if (parts.length === 3 && parts[2] === "content") {
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
      if (req.method === "GET") {
        return this.send(res, 200, this.campaignContent.get(id) || { plain_text: "", html: "", _links: [] });
      }
      if (req.method === "PUT") {
        const content = { plain_text: body?.plain_text || "", html: body?.html || "", _links: [] };
        if (isPlainObject(body?.template)) content.html = `<!-- template ${body.template.id} -->`;
        this.campaignContent.set(id, content);
        return this.send(res, 200, content);
      }
      return this.methodNotAllowed(res);
    }
    // /campaigns/{id}/send-checklist
    if (parts.length === 3 && parts[2] === "send-checklist" && req.method === "GET") {
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
      return this.send(res, 200, { is_ready: true, items: [] });
    }
    // /campaigns/{id}/feedback
    if (parts.length >= 3 && parts[2] === "feedback") {
      return this.routeCampaignFeedback(req, res, parts, body, rec);
    }
    // /campaigns/{id}/actions/<action>
    if (parts.length === 4 && parts[2] === "actions" && req.method === "POST") {
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
      return this.campaignAction(res, rec, parts[3], body);
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  createCampaign(res, body) {
    if (!isPlainObject(body) || !body.type) {
      return this.send(res, 400, this._invalidResource("type", "Campaign requires a type."));
    }
    const validTypes = ["regular", "plaintext", "absplit", "rss", "variate"];
    if (!validTypes.includes(body.type)) {
      return this.send(res, 400, this._invalidResource("type", "Invalid campaign type."));
    }
    const id = newId();
    const rec = {
      id,
      web_id: Math.floor(Math.random() * 1e6),
      type: body.type,
      create_time: now(),
      archive_url: `https://parlel.test/archive/${id}`,
      long_archive_url: `https://parlel.test/archive/${id}/full`,
      status: "save",
      emails_sent: 0,
      send_time: "",
      content_type: "template",
      recipients: body.recipients || { list_id: null },
      settings: body.settings || {},
      tracking: body.tracking || { opens: true, html_clicks: true, text_clicks: false },
      delivery_status: { enabled: false },
      _links: [],
    };
    this.campaigns.set(id, rec);
    return this.send(res, 200, clone(rec));
  }

  campaignAction(res, rec, action, body) {
    switch (action) {
      case "send":
        rec.status = "sent";
        rec.send_time = now();
        rec.emails_sent = 1;
        return this.send(res, 204, null);
      case "schedule":
        rec.status = "schedule";
        rec.send_time = body?.schedule_time || now();
        return this.send(res, 204, null);
      case "unschedule":
        rec.status = "save";
        rec.send_time = "";
        return this.send(res, 204, null);
      case "pause":
        rec.status = "paused";
        return this.send(res, 204, null);
      case "resume":
        rec.status = "sending";
        return this.send(res, 204, null);
      case "cancel-send":
        rec.status = "canceled";
        return this.send(res, 204, null);
      case "test":
        return this.send(res, 204, null);
      case "replicate": {
        const id = newId();
        const copy = { ...clone(rec), id, status: "save", create_time: now(), send_time: "", emails_sent: 0 };
        this.campaigns.set(id, copy);
        return this.send(res, 200, copy);
      }
      case "create-resend": {
        const id = newId();
        const copy = { ...clone(rec), id, status: "save", create_time: now(), send_time: "", emails_sent: 0 };
        this.campaigns.set(id, copy);
        return this.send(res, 200, copy);
      }
      default:
        return this.send(res, 404, mcError(404, "Resource Not Found", "Unknown campaign action."));
    }
  }

  routeCampaignFeedback(req, res, parts, body, rec) {
    if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Campaign not found."));
    rec._feedback = rec._feedback || new Map();
    rec._feedbackSeq = rec._feedbackSeq || 0;
    if (parts.length === 3) {
      if (req.method === "GET") return this.send(res, 200, { feedback: Array.from(rec._feedback.values()), total_items: rec._feedback.size });
      if (req.method === "POST") {
        const id = String(++rec._feedbackSeq);
        const fb = { feedback_id: Number(id), message: body?.message || "", created_at: now(), created_by: "parlel", is_complete: Boolean(body?.is_complete), campaign_id: rec.id };
        rec._feedback.set(id, fb);
        return this.send(res, 200, fb);
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 4) {
      const id = parts[3];
      const fb = rec._feedback.get(id);
      if (req.method === "GET") {
        if (!fb) return this.send(res, 404, mcError(404, "Resource Not Found", "Feedback not found."));
        return this.send(res, 200, fb);
      }
      if (req.method === "PATCH") {
        if (!fb) return this.send(res, 404, mcError(404, "Resource Not Found", "Feedback not found."));
        if (body?.message != null) fb.message = body.message;
        return this.send(res, 200, fb);
      }
      if (req.method === "DELETE") {
        if (!fb) return this.send(res, 404, mcError(404, "Resource Not Found", "Feedback not found."));
        rec._feedback.delete(id);
        return this.send(res, 204, null);
      }
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Folders (campaign + template, shared logic)
  // =========================================================================
  routeFolders(req, res, parts, body, store, kind) {
    const key = kind === "campaign" ? "campaign-folders" : "template-folders";
    const countKey = kind === "campaign" ? "count" : "count";
    if (parts.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, { folders: Array.from(store.values()).map(clone), total_items: store.size, _links: [] });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.name) return this.send(res, 400, this._invalidResource("name", "Folder requires a name."));
        const id = newId();
        const rec = { id, name: body.name, count: 0, _links: [] };
        store.set(id, rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2) {
      const id = parts[1];
      const rec = store.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Folder not found."));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Folder not found."));
        if (typeof body.name === "string") rec.name = body.name;
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Folder not found."));
        store.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Templates
  // =========================================================================
  routeTemplates(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, { templates: Array.from(this.templates.values()).map(clone), total_items: this.templates.size, _links: [] });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.name) return this.send(res, 400, this._invalidResource("name", "Template requires a name."));
        const id = newId();
        const rec = {
          id: Number(id.replace(/\D/g, "").slice(0, 6) || "0") || Math.floor(Math.random() * 1e6),
          type: "user",
          name: body.name,
          drag_and_drop: false,
          responsive: true,
          category: "",
          date_created: now(),
          date_edited: now(),
          created_by: "parlel",
          edited_by: "parlel",
          active: true,
          folder_id: body.folder_id || "",
          thumbnail: "",
          share_url: "",
          _html: body.html || "",
          _links: [],
        };
        this.templates.set(String(rec.id), rec);
        return this.send(res, 200, this._templateView(rec));
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2) {
      const id = parts[1];
      const rec = this.templates.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Template not found."));
        return this.send(res, 200, this._templateView(rec));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Template not found."));
        if (typeof body.name === "string") rec.name = body.name;
        if (typeof body.html === "string") rec._html = body.html;
        if (body.folder_id != null) rec.folder_id = body.folder_id;
        rec.date_edited = now();
        return this.send(res, 200, this._templateView(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Template not found."));
        this.templates.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    // /templates/{id}/default-content
    if (parts.length === 3 && parts[2] === "default-content" && req.method === "GET") {
      const rec = this.templates.get(parts[1]);
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Template not found."));
      return this.send(res, 200, { sections: {}, _links: [] });
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  _templateView(rec) {
    const view = clone(rec);
    delete view._html;
    return view;
  }

  // =========================================================================
  // Reports (read-only)
  // =========================================================================
  routeReports(req, res, parts, body) {
    if (req.method !== "GET") return this.methodNotAllowed(res);
    if (parts.length === 1) {
      const reports = Array.from(this.campaigns.values())
        .filter((c) => c.status === "sent")
        .map((c) => this._reportView(c));
      return this.send(res, 200, { reports, total_items: reports.length, _links: [] });
    }
    const id = parts[1];
    const camp = this.campaigns.get(id);
    if (parts.length === 2) {
      if (!camp) return this.send(res, 404, mcError(404, "Resource Not Found", "Report not found."));
      return this.send(res, 200, this._reportView(camp));
    }
    // sub-reports
    if (!camp) return this.send(res, 404, mcError(404, "Resource Not Found", "Report not found."));
    const sub = parts[2];
    const wrapKeys = {
      "abuse-reports": "abuse_reports",
      "advice": "advice",
      "click-details": "urls_clicked",
      "domain-performance": "domains",
      "email-activity": "emails",
      "locations": "locations",
      "open-details": "members",
      "sent-to": "sent_to",
      "sub-reports": "sub_reports",
      "unsubscribed": "unsubscribes",
      "eepurl": null,
      "ecommerce-product-activity": "products",
    };
    if (sub in wrapKeys) {
      const wrap = wrapKeys[sub];
      if (wrap === null) return this.send(res, 200, { twitter: {}, clicks: 0, referrers: [], campaign_id: id });
      return this.send(res, 200, { [wrap]: [], campaign_id: id, total_items: 0, _links: [] });
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  _reportView(c) {
    return {
      id: c.id,
      campaign_title: c.settings?.title || "",
      type: c.type,
      list_id: c.recipients?.list_id || "",
      emails_sent: c.emails_sent || 0,
      abuse_reports: 0,
      unsubscribed: 0,
      send_time: c.send_time || "",
      bounces: { hard_bounces: 0, soft_bounces: 0, syntax_errors: 0 },
      forwards: { forwards_count: 0, forwards_opens: 0 },
      opens: { opens_total: 0, unique_opens: 0, open_rate: 0, last_open: "" },
      clicks: { clicks_total: 0, unique_clicks: 0, click_rate: 0, last_click: "" },
      _links: [],
    };
  }

  // =========================================================================
  // E-commerce
  // =========================================================================
  routeEcommerce(req, res, parts, body) {
    // /ecommerce/orders  (account-wide)
    if (parts.length === 2 && parts[1] === "orders" && req.method === "GET") {
      const all = [];
      for (const [storeId, bucket] of this.orders) for (const o of bucket.values()) all.push(clone(o));
      return this.send(res, 200, { orders: all, total_items: all.length, _links: [] });
    }
    if (parts[1] !== "stores") return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));

    // /ecommerce/stores
    if (parts.length === 2) {
      if (req.method === "GET") return this.send(res, 200, { stores: Array.from(this.stores.values()).map(clone), total_items: this.stores.size, _links: [] });
      if (req.method === "POST") return this.createStore(res, body);
      return this.methodNotAllowed(res);
    }

    const storeId = parts[2];
    const store = this.stores.get(storeId);

    // /ecommerce/stores/{id}
    if (parts.length === 3) {
      if (req.method === "GET") {
        if (!store) return this.send(res, 404, mcError(404, "Resource Not Found", "Store not found."));
        return this.send(res, 200, clone(store));
      }
      if (req.method === "PATCH") {
        if (!store) return this.send(res, 404, mcError(404, "Resource Not Found", "Store not found."));
        for (const k of ["name", "currency_code", "platform", "domain", "email_address"]) if (typeof body[k] === "string") store[k] = body[k];
        store.updated_at = now();
        return this.send(res, 200, clone(store));
      }
      if (req.method === "DELETE") {
        if (!store) return this.send(res, 404, mcError(404, "Resource Not Found", "Store not found."));
        this.stores.delete(storeId);
        this.products.delete(storeId);
        this.customers.delete(storeId);
        this.orders.delete(storeId);
        this.carts.delete(storeId);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }

    if (!store) return this.send(res, 404, mcError(404, "Resource Not Found", "Store not found."));
    const sub = parts[3];
    if (sub === "products") return this.routeEcommerceCollection(req, res, parts, body, this.products.get(storeId), storeId, "product", "products");
    if (sub === "customers") return this.routeEcommerceCollection(req, res, parts, body, this.customers.get(storeId), storeId, "customer", "customers");
    if (sub === "orders") return this.routeEcommerceCollection(req, res, parts, body, this.orders.get(storeId), storeId, "order", "orders");
    if (sub === "carts") return this.routeEcommerceCollection(req, res, parts, body, this.carts.get(storeId), storeId, "cart", "carts");
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  createStore(res, body) {
    if (!isPlainObject(body) || !body.id || !body.name || !body.currency_code) {
      return this.send(res, 400, this._invalidResource("id", "Store requires id, list_id, name, currency_code."));
    }
    if (this.stores.has(body.id)) {
      return this.send(res, 400, mcError(400, "Bad Request", "A store with the provided ID already exists."));
    }
    const rec = {
      id: body.id,
      list_id: body.list_id || null,
      name: body.name,
      platform: body.platform || "",
      domain: body.domain || "",
      is_syncing: false,
      email_address: body.email_address || "",
      currency_code: body.currency_code,
      money_format: body.money_format || "$",
      primary_locale: body.primary_locale || "en",
      timezone: body.timezone || "",
      phone: body.phone || "",
      address: body.address || {},
      connected_site: {},
      automations: {},
      list_is_active: true,
      created_at: now(),
      updated_at: now(),
      _links: [],
    };
    this.stores.set(rec.id, rec);
    this.products.set(rec.id, new Map());
    this.customers.set(rec.id, new Map());
    this.orders.set(rec.id, new Map());
    this.carts.set(rec.id, new Map());
    return this.send(res, 200, clone(rec));
  }

  routeEcommerceCollection(req, res, parts, body, bucket, storeId, kind, wrapKey) {
    const idField = kind === "product" || kind === "customer" || kind === "order" || kind === "cart" ? "id" : "id";
    // /ecommerce/stores/{id}/<collection>
    if (parts.length === 4) {
      if (req.method === "GET") return this.send(res, 200, { store_id: storeId, [wrapKey]: Array.from(bucket.values()).map(clone), total_items: bucket.size, _links: [] });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.id) return this.send(res, 400, this._invalidResource("id", `${kind} requires an id.`));
        if (bucket.has(String(body.id))) return this.send(res, 400, mcError(400, "Bad Request", `A ${kind} with the provided ID already exists.`));
        const rec = this._buildEcommerceRecord(kind, storeId, body);
        bucket.set(String(rec.id), rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    // /ecommerce/stores/{id}/<collection>/{itemId}
    if (parts.length === 5) {
      const itemId = parts[4];
      const rec = bucket.get(itemId);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", `${kind} not found.`));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PUT") {
        const exists = bucket.has(itemId);
        const merged = this._buildEcommerceRecord(kind, storeId, { ...(exists ? rec : {}), ...body, id: itemId });
        merged.updated_at = now();
        bucket.set(itemId, merged);
        return this.send(res, 200, clone(merged));
      }
      if (req.method === "PATCH") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", `${kind} not found.`));
        Object.assign(rec, body, { id: itemId });
        rec.updated_at = now();
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", `${kind} not found.`));
        bucket.delete(itemId);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    // /ecommerce/stores/{id}/products/{pid}/variants | images, orders/{oid}/lines, carts/{cid}/lines
    if (parts.length >= 6) {
      const itemId = parts[4];
      const rec = bucket.get(itemId);
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", `${kind} not found.`));
      const child = parts[5];
      const childMapKey = `_${child}`;
      rec[childMapKey] = rec[childMapKey] || [];
      if (parts.length === 6) {
        if (req.method === "GET") return this.send(res, 200, { store_id: storeId, [child]: clone(rec[childMapKey]), total_items: rec[childMapKey].length, _links: [] });
        if (req.method === "POST") {
          if (!body?.id) return this.send(res, 400, this._invalidResource("id", `${child} item requires an id.`));
          const item = { ...body, _links: [] };
          rec[childMapKey].push(item);
          return this.send(res, 200, clone(item));
        }
      }
      if (parts.length === 7) {
        const childId = parts[6];
        const idx = rec[childMapKey].findIndex((x) => String(x.id) === childId);
        if (req.method === "GET") {
          if (idx < 0) return this.send(res, 404, mcError(404, "Resource Not Found", "Line item not found."));
          return this.send(res, 200, clone(rec[childMapKey][idx]));
        }
        if (req.method === "PATCH" || req.method === "PUT") {
          if (idx < 0 && req.method === "PATCH") return this.send(res, 404, mcError(404, "Resource Not Found", "Line item not found."));
          if (idx < 0) { const item = { ...body, id: childId, _links: [] }; rec[childMapKey].push(item); return this.send(res, 200, clone(item)); }
          rec[childMapKey][idx] = { ...rec[childMapKey][idx], ...body, id: childId };
          return this.send(res, 200, clone(rec[childMapKey][idx]));
        }
        if (req.method === "DELETE") {
          if (idx < 0) return this.send(res, 404, mcError(404, "Resource Not Found", "Line item not found."));
          rec[childMapKey].splice(idx, 1);
          return this.send(res, 204, null);
        }
      }
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  _buildEcommerceRecord(kind, storeId, body) {
    const base = { ...clone(body), store_id: storeId, created_at: body.created_at || now(), updated_at: now(), _links: [] };
    base.id = String(body.id);
    // Orders and carts carry nested line items. Mirror them into the internal
    // `_lines` store so the .../lines sub-routes can read/modify them, while
    // still exposing `lines` on the parent record (as the real API does).
    if ((kind === "order" || kind === "cart") && Array.isArray(body.lines)) {
      base._lines = clone(body.lines);
    }
    return base;
  }

  // =========================================================================
  // File Manager
  // =========================================================================
  routeFileManager(req, res, parts, body) {
    const sub = parts[1];
    if (sub === "files") {
      if (parts.length === 2) {
        if (req.method === "GET") return this.send(res, 200, { files: Array.from(this.files.values()).map(clone), total_file_size: 0, total_items: this.files.size, _links: [] });
        if (req.method === "POST") {
          if (!isPlainObject(body) || !body.name || body.file_data === undefined) {
            return this.send(res, 400, this._invalidResource("name", "File requires name and file_data."));
          }
          const id = ++this.fileSeq;
          const rec = {
            id, folder_id: body.folder_id || 0, type: "image", name: body.name,
            full_size_url: `https://parlel.test/files/${id}/${body.name}`, thumbnail_url: "",
            size: typeof body.file_data === "string" ? body.file_data.length : 0,
            created_at: now(), created_by: "parlel", width: 0, height: 0, _links: [],
          };
          this.files.set(String(id), rec);
          return this.send(res, 200, clone(rec));
        }
        return this.methodNotAllowed(res);
      }
      if (parts.length === 3) {
        const id = parts[2];
        const rec = this.files.get(id);
        if (req.method === "GET") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "File not found.")); return this.send(res, 200, clone(rec)); }
        if (req.method === "PATCH") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "File not found.")); if (typeof body.name === "string") rec.name = body.name; if (body.folder_id != null) rec.folder_id = body.folder_id; return this.send(res, 200, clone(rec)); }
        if (req.method === "DELETE") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "File not found.")); this.files.delete(id); return this.send(res, 204, null); }
        return this.methodNotAllowed(res);
      }
    }
    if (sub === "folders") {
      if (parts.length === 2) {
        if (req.method === "GET") return this.send(res, 200, { folders: Array.from(this.fileFolders.values()).map(clone), total_items: this.fileFolders.size, _links: [] });
        if (req.method === "POST") {
          if (!isPlainObject(body) || !body.name) return this.send(res, 400, this._invalidResource("name", "Folder requires a name."));
          const id = ++this.fileFolderSeq;
          const rec = { id, name: body.name, file_count: 0, created_at: now(), created_by: "parlel", _links: [] };
          this.fileFolders.set(String(id), rec);
          return this.send(res, 200, clone(rec));
        }
        return this.methodNotAllowed(res);
      }
      if (parts.length === 3) {
        const id = parts[2];
        const rec = this.fileFolders.get(id);
        if (req.method === "GET") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Folder not found.")); return this.send(res, 200, clone(rec)); }
        if (req.method === "PATCH") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Folder not found.")); if (typeof body.name === "string") rec.name = body.name; return this.send(res, 200, clone(rec)); }
        if (req.method === "DELETE") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Folder not found.")); this.fileFolders.delete(id); return this.send(res, 204, null); }
        return this.methodNotAllowed(res);
      }
      // /file-manager/folders/{id}/files
      if (parts.length === 4 && parts[3] === "files" && req.method === "GET") {
        const id = parts[2];
        const files = Array.from(this.files.values()).filter((f) => String(f.folder_id) === id).map(clone);
        return this.send(res, 200, { files, total_file_size: 0, total_items: files.length, _links: [] });
      }
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Verified Domains
  // =========================================================================
  routeVerifiedDomains(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, { domains: Array.from(this.verifiedDomains.values()).map(clone), total_items: this.verifiedDomains.size, _links: [] });
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.verification_email) {
          return this.send(res, 400, this._invalidResource("verification_email", "verification_email is required."));
        }
        const domain = body.verification_email.split("@")[1] || body.verification_email;
        const rec = { domain, authenticated: false, verified: false, verification_sent: true, verification_email: body.verification_email };
        this.verifiedDomains.set(domain, rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    const name = parts[1];
    if (parts.length === 2) {
      const rec = this.verifiedDomains.get(name);
      if (req.method === "GET") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Domain not found.")); return this.send(res, 200, clone(rec)); }
      if (req.method === "DELETE") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Domain not found.")); this.verifiedDomains.delete(name); return this.send(res, 204, null); }
      return this.methodNotAllowed(res);
    }
    // /verified-domains/{name}/actions/verify
    if (parts.length === 4 && parts[2] === "actions" && parts[3] === "verify" && req.method === "POST") {
      const rec = this.verifiedDomains.get(name);
      if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Domain not found."));
      rec.verified = true;
      rec.authenticated = true;
      return this.send(res, 200, clone(rec));
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Batch operations
  // =========================================================================
  routeBatches(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, { batches: Array.from(this.batches.values()).map(clone), total_items: this.batches.size, _links: [] });
      if (req.method === "POST") {
        const ops = Array.isArray(body?.operations) ? body.operations : [];
        const id = newId();
        const rec = {
          id, status: "finished", total_operations: ops.length, finished_operations: ops.length, errored_operations: 0,
          submitted_at: now(), completed_at: now(), response_body_url: `https://parlel.test/batches/${id}/response`,
          _links: [],
        };
        this.batches.set(id, rec);
        return this.send(res, 200, clone(rec));
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2) {
      const id = parts[1];
      const rec = this.batches.get(id);
      if (req.method === "GET") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Batch not found.")); return this.send(res, 200, clone(rec)); }
      if (req.method === "DELETE") { if (!rec) return this.send(res, 404, mcError(404, "Resource Not Found", "Batch not found.")); this.batches.delete(id); return this.send(res, 204, null); }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Search members
  // =========================================================================
  searchMembers(res, url) {
    const query = (url.searchParams.get("query") || "").toLowerCase();
    const exact = [];
    const full = [];
    for (const [listId, bucket] of this.members) {
      for (const m of bucket.values()) {
        const email = m.email_address.toLowerCase();
        if (email === query) exact.push(clone(m));
        else if (query && email.includes(query)) full.push(clone(m));
      }
    }
    return this.send(res, 200, {
      exact_matches: { members: exact, total_items: exact.length },
      full_search: { members: full, total_items: full.length },
      _links: [],
    });
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
        lists: this.lists.size,
        members: this._totalSubscribers(),
        campaigns: this.campaigns.size,
        templates: this.templates.size,
        stores: this.stores.size,
      });
    }
    return this.send(res, 404, mcError(404, "Resource Not Found", "Not found."));
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  _invalidResource(field, message) {
    return {
      type: "https://mailchimp.com/developer/marketing/docs/errors/",
      title: "Invalid Resource",
      status: 400,
      detail: "The resource submitted could not be validated. For field-specific details, see the 'errors' array.",
      instance: randomUUID(),
      errors: [{ field, message }],
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Accept Basic auth (the official client default) or OAuth2 Bearer.
    return /^Basic\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
  }

  methodNotAllowed(res) {
    return this.send(res, 405, mcError(405, "Method Not Allowed", "The method is not allowed for the requested resource."));
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
          this.send(res, 400, mcError(400, "Bad Request", "We encountered an error processing your request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, mcError(400, "Bad Request", "We encountered an error processing your request body."));
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
