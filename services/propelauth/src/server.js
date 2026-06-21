import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/propelauth — dependency-free fake of the PropelAuth Backend API.
// In-memory, ephemeral, deterministic. Bearer auth (API key).
// Source: https://docs.propelauth.com/reference/api
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function splitPath(p) {
  return p.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function uuid(seed) {
  const h = createHash("sha256").update(String(seed)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export class PropelauthServer {
  constructor(port = 4825, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.byEmail = new Map();
    this.orgs = new Map();
    this.orgMembers = new Map(); // orgId -> Map<userId, { role, additional_roles }>
    this.counter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: error.message });
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
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-propelauth");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, null);
    }

    if (!(parts[0] === "api" && parts[1] === "backend" && parts[2] === "v1")) {
      return this.send(res, 404, null);
    }

    if (!this.isAuthorized(req)) {
      return this.sendText(res, 401, "No authorization header found");
    }

    const route = parts.slice(3);
    if (route[0] === "user") return this.handleUser(req, res, route, body, url);
    if (route[0] === "org") return this.handleOrg(req, res, route, body, url);

    return this.send(res, 404, null);
  }

  handleUser(req, res, route, body, url) {
    // POST /api/backend/v1/user/  (create)
    if (route.length === 1 && req.method === "POST") {
      const errors = {};
      if (!body.email || !EMAIL_RE.test(body.email)) {
        errors.email = errors.email || [];
        errors.email.push("Email is invalid");
      }
      if (body.email && this.byEmail.has(body.email)) {
        errors.email = errors.email || [];
        errors.email.push("A user with this email address already exists");
      }
      if (Object.keys(errors).length > 0) {
        return this.send(res, 400, errors);
      }
      const user = this._createUser(body);
      return this.send(res, 200, { user_id: user.user_id });
    }

    // GET /api/backend/v1/user/email?email=
    if (route.length === 2 && route[1] === "email" && req.method === "GET") {
      const email = url.searchParams.get("email");
      const user = email ? this.users.get(this.byEmail.get(email)) : null;
      if (!user) return this.send(res, 404, null);
      return this.send(res, 200, this._publicUser(user));
    }

    // GET /api/backend/v1/user/username?username=
    if (route.length === 2 && route[1] === "username" && req.method === "GET") {
      const username = url.searchParams.get("username");
      let found = null;
      if (username) {
        for (const u of this.users.values()) {
          if (u.username === username) { found = u; break; }
        }
      }
      if (!found) return this.send(res, 404, null);
      return this.send(res, 200, this._publicUser(found));
    }

    // POST /api/backend/v1/user/user_ids  (batch fetch by IDs)
    if (route.length === 2 && route[1] === "user_ids" && req.method === "POST") {
      const ids = Array.isArray(body.user_ids) ? body.user_ids : [];
      const users = ids.map((id) => this.users.get(id)).filter(Boolean).map((u) => this._publicUser(u));
      return this.send(res, 200, { users });
    }

    // POST /api/backend/v1/user/emails  (batch fetch by emails)
    if (route.length === 2 && route[1] === "emails" && req.method === "POST") {
      const emails = Array.isArray(body.emails) ? body.emails : [];
      const users = emails
        .map((e) => this.byEmail.get(e))
        .filter(Boolean)
        .map((id) => this._publicUser(this.users.get(id)));
      return this.send(res, 200, { users });
    }

    // GET /api/backend/v1/user/query
    if (route.length === 2 && route[1] === "query" && req.method === "GET") {
      const pageSize = Math.max(1, Number(url.searchParams.get("page_size") || "10"));
      const pageNumber = Math.max(0, Number(url.searchParams.get("page_number") || "0"));
      const all = [...this.users.values()].map((u) => this._publicUser(u));
      const start = pageNumber * pageSize;
      const page = all.slice(start, start + pageSize);
      return this.send(res, 200, {
        total_users: all.length,
        current_page: pageNumber,
        page_size: pageSize,
        has_more_results: start + pageSize < all.length,
        users: page,
      });
    }

    // GET /api/backend/v1/user/org/:orgId  (users in org)
    if (route.length === 3 && route[1] === "org" && req.method === "GET") {
      const orgId = route[2];
      const org = this.orgs.get(orgId);
      if (!org) return this.send(res, 404, null);
      const members = this.orgMembers.get(orgId) || new Map();
      const pageSize = Math.max(1, Number(url.searchParams.get("page_size") || "10"));
      const pageNumber = Math.max(0, Number(url.searchParams.get("page_number") || "0"));
      const role = url.searchParams.get("role");
      let userIds = [...members.entries()];
      if (role) userIds = userIds.filter(([, m]) => m.role === role);
      const all = userIds
        .map(([uid]) => this.users.get(uid))
        .filter(Boolean)
        .map((u) => this._publicUser(u));
      const start = pageNumber * pageSize;
      const page = all.slice(start, start + pageSize);
      return this.send(res, 200, {
        total_users: all.length,
        current_page: pageNumber,
        page_size: pageSize,
        has_more_results: start + pageSize < all.length,
        users: page,
      });
    }

    // GET/PUT/DELETE /api/backend/v1/user/:userId
    if (route.length === 2) {
      const id = route[1];
      const user = this.users.get(id);
      if (req.method === "GET") {
        if (!user) return this.send(res, 404, null);
        return this.send(res, 200, this._publicUser(user));
      }
      if (req.method === "PUT") {
        if (!user) return this.send(res, 404, null);
        if (typeof body.email === "string" && EMAIL_RE.test(body.email)) {
          if (user.email) this.byEmail.delete(user.email);
          user.email = body.email;
          this.byEmail.set(body.email, user.user_id);
        }
        if (typeof body.first_name === "string") user.first_name = body.first_name;
        if (typeof body.last_name === "string") user.last_name = body.last_name;
        if (typeof body.username === "string") user.username = body.username;
        if (typeof body.picture_url === "string") user.picture_url = body.picture_url;
        if (typeof body.email_confirmed === "boolean") user.email_confirmed = body.email_confirmed;
        if (isPlainObject(body.metadata)) user.metadata = clone(body.metadata);
        if (isPlainObject(body.properties)) user.properties = { ...user.properties, ...clone(body.properties) };
        if (typeof body.update_password_required === "boolean") user.update_password_required = body.update_password_required;
        if (typeof body.legacy_user_id === "string") user.legacy_user_id = body.legacy_user_id;
        return this.send(res, 200, {});
      }
      if (req.method === "DELETE") {
        if (!user) return this.send(res, 404, null);
        if (user.email) this.byEmail.delete(user.email);
        this.users.delete(id);
        return this.send(res, 200, {});
      }
    }

    // PUT /api/backend/v1/user/:userId/email
    if (route.length === 3 && route[2] === "email" && req.method === "PUT") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      const errors = {};
      if (!body.new_email || !EMAIL_RE.test(body.new_email)) {
        errors.new_email = ["Email is invalid"];
      }
      if (body.new_email && this.byEmail.has(body.new_email) && this.byEmail.get(body.new_email) !== user.user_id) {
        errors.new_email = errors.new_email || [];
        errors.new_email.push("A user with this email address already exists");
      }
      if (Object.keys(errors).length > 0) return this.send(res, 400, errors);
      if (user.email) this.byEmail.delete(user.email);
      user.email = body.new_email;
      if (body.require_email_confirmation === false) {
        user.email_confirmed = true;
      }
      this.byEmail.set(user.email, user.user_id);
      return this.send(res, 200, {});
    }

    // PUT /api/backend/v1/user/:userId/password
    if (route.length === 3 && route[2] === "password" && req.method === "PUT") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      if (!body.password) return this.send(res, 400, { password: ["Password is required"] });
      user.password = body.password;
      user.has_password = true;
      if (typeof body.ask_user_to_update_password_on_login === "boolean") {
        user.update_password_required = body.ask_user_to_update_password_on_login;
      }
      return this.send(res, 200, {});
    }

    // PUT /api/backend/v1/user/:userId/clear_password
    if (route.length === 3 && route[2] === "clear_password" && req.method === "PUT") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      user.password = null;
      user.has_password = false;
      user.update_password_required = false;
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/user/:userId/disable
    if (route.length === 3 && route[2] === "disable" && req.method === "POST") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      user.enabled = false;
      user.locked = true;
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/user/:userId/enable
    if (route.length === 3 && route[2] === "enable" && req.method === "POST") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      user.enabled = true;
      user.locked = false;
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/user/:userId/disable_2fa
    if (route.length === 3 && route[2] === "disable_2fa" && req.method === "POST") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      user.mfa_enabled = false;
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/user/:userId/logout_all_sessions
    if (route.length === 3 && route[2] === "logout_all_sessions" && req.method === "POST") {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, null);
      return this.send(res, 200, {});
    }

    return this.send(res, 404, null);
  }

  handleOrg(req, res, route, body, url) {
    // GET /api/backend/v1/org/  (list all)
    if (route.length === 1 && req.method === "GET") {
      const all = [...this.orgs.values()].map((o) => this._listOrg(o));
      return this.send(res, 200, {
        total_orgs: all.length,
        current_page: 0,
        page_size: all.length || 10,
        has_more_results: false,
        orgs: all,
      });
    }

    // POST /api/backend/v1/org/  (create)
    if (route.length === 1 && req.method === "POST") {
      const errors = {};
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        errors.name = ["Name is required"];
      }
      if (Object.keys(errors).length > 0) return this.send(res, 400, errors);
      this.counter += 1;
      const org_id = uuid(`${body.name}:${this.counter}`);
      const org = {
        org_id,
        name: body.name,
        url_safe_org_slug: slugify(body.name) || org_id.slice(0, 8),
        can_setup_saml: false,
        is_saml_configured: false,
        is_saml_in_test_mode: false,
        domain: body.domain || null,
        extra_domains: [],
        domain_autojoin: Boolean(body.autojoin_by_domain),
        domain_restrict: Boolean(body.restrict_to_domain),
        max_users: body.max_users ?? null,
        custom_role_mapping_name: body.custom_role_mapping_name || null,
        legacy_org_id: body.legacy_org_id || null,
        isolated: false,
        metadata: clone(body.metadata) || {},
        password_rotation_enabled: false,
        password_rotation_history_size: 0,
        password_rotation_period: 0,
        created_at: Math.floor(Date.now() / 1000),
      };
      this.orgs.set(org_id, org);
      this.orgMembers.set(org_id, new Map());
      return this.send(res, 200, { org_id, name: org.name });
    }

    // POST /api/backend/v1/org/query
    if (route.length === 2 && route[1] === "query" && req.method === "POST") {
      const pageSize = Math.max(1, Number(body.page_size || 10));
      const pageNumber = Math.max(0, Number(body.page_number || 0));
      let all = [...this.orgs.values()];
      if (body.name) {
        const q = String(body.name).toLowerCase();
        all = all.filter((o) => o.name.toLowerCase().includes(q));
      }
      if (body.domain) {
        all = all.filter((o) => o.domain === body.domain);
      }
      if (body.legacy_org_id) {
        all = all.filter((o) => o.legacy_org_id === body.legacy_org_id);
      }
      if (body.order_by === "NAME") {
        all.sort((a, b) => a.name.localeCompare(b.name));
      } else if (body.order_by === "CREATED_AT_DESC") {
        all.sort((a, b) => b.created_at - a.created_at);
      } else {
        all.sort((a, b) => a.created_at - b.created_at);
      }
      const mapped = all.map((o) => this._listOrg(o));
      const start = pageNumber * pageSize;
      const page = mapped.slice(start, start + pageSize);
      return this.send(res, 200, {
        total_orgs: mapped.length,
        current_page: pageNumber,
        page_size: pageSize,
        has_more_results: start + pageSize < mapped.length,
        orgs: page,
      });
    }

    // POST /api/backend/v1/org/add_user
    if (route.length === 2 && route[1] === "add_user" && req.method === "POST") {
      const errors = {};
      if (!body.user_id) errors.user_id = ["user_id is required"];
      if (!body.org_id) errors.org_id = ["org_id is required"];
      if (!body.role) errors.role = ["role is required"];
      if (Object.keys(errors).length > 0) return this.send(res, 400, errors);
      const user = this.users.get(body.user_id);
      if (!user) return this.send(res, 404, null);
      const org = this.orgs.get(body.org_id);
      if (!org) return this.send(res, 404, null);
      if (!this.orgMembers.has(body.org_id)) this.orgMembers.set(body.org_id, new Map());
      this.orgMembers.get(body.org_id).set(body.user_id, {
        role: body.role,
        additional_roles: Array.isArray(body.additional_roles) ? body.additional_roles : [],
      });
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/org/remove_user
    if (route.length === 2 && route[1] === "remove_user" && req.method === "POST") {
      const errors = {};
      if (!body.user_id) errors.user_id = ["user_id is required"];
      if (!body.org_id) errors.org_id = ["org_id is required"];
      if (Object.keys(errors).length > 0) return this.send(res, 400, errors);
      const members = this.orgMembers.get(body.org_id);
      if (members) members.delete(body.user_id);
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/org/change_role
    if (route.length === 2 && route[1] === "change_role" && req.method === "POST") {
      const errors = {};
      if (!body.user_id) errors.user_id = ["user_id is required"];
      if (!body.org_id) errors.org_id = ["org_id is required"];
      if (!body.role) errors.role = ["role is required"];
      if (Object.keys(errors).length > 0) return this.send(res, 400, errors);
      const members = this.orgMembers.get(body.org_id);
      if (!members || !members.has(body.user_id)) return this.send(res, 404, null);
      members.set(body.user_id, {
        role: body.role,
        additional_roles: Array.isArray(body.additional_roles) ? body.additional_roles : [],
      });
      return this.send(res, 200, {});
    }

    // GET /api/backend/v1/org/:orgId  (fetch single)
    if (route.length === 2 && req.method === "GET") {
      const org = this.orgs.get(route[1]);
      if (!org) return this.send(res, 404, null);
      return this.send(res, 200, this._fullOrg(org));
    }

    // PUT /api/backend/v1/org/:orgId  (update)
    if (route.length === 2 && req.method === "PUT") {
      const org = this.orgs.get(route[1]);
      if (!org) return this.send(res, 404, null);
      if (typeof body.name === "string") { org.name = body.name; org.url_safe_org_slug = slugify(body.name); }
      if (typeof body.domain === "string") org.domain = body.domain;
      if (Array.isArray(body.extra_domains)) org.extra_domains = body.extra_domains;
      if (typeof body.autojoin_by_domain === "boolean") org.domain_autojoin = body.autojoin_by_domain;
      if (typeof body.restrict_to_domain === "boolean") org.domain_restrict = body.restrict_to_domain;
      if (body.max_users !== undefined) org.max_users = body.max_users;
      if (typeof body.can_setup_saml === "boolean") org.can_setup_saml = body.can_setup_saml;
      if (typeof body.legacy_org_id === "string") org.legacy_org_id = body.legacy_org_id;
      if (isPlainObject(body.metadata)) org.metadata = clone(body.metadata);
      if (typeof body.custom_role_mapping_name === "string") org.custom_role_mapping_name = body.custom_role_mapping_name;
      if (typeof body.isolated === "boolean") org.isolated = body.isolated;
      if (typeof body.password_rotation_enabled === "boolean") org.password_rotation_enabled = body.password_rotation_enabled;
      if (typeof body.password_rotation_history_size === "number") org.password_rotation_history_size = body.password_rotation_history_size;
      if (typeof body.password_rotation_period === "number") org.password_rotation_period = body.password_rotation_period;
      return this.send(res, 200, {});
    }

    // DELETE /api/backend/v1/org/:orgId
    if (route.length === 2 && req.method === "DELETE") {
      if (!this.orgs.has(route[1])) return this.send(res, 404, null);
      this.orgs.delete(route[1]);
      this.orgMembers.delete(route[1]);
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/org/:orgId/allow_saml
    if (route.length === 3 && route[2] === "allow_saml" && req.method === "POST") {
      const org = this.orgs.get(route[1]);
      if (!org) return this.send(res, 404, null);
      org.can_setup_saml = true;
      return this.send(res, 200, {});
    }

    // POST /api/backend/v1/org/:orgId/disallow_saml
    if (route.length === 3 && route[2] === "disallow_saml" && req.method === "POST") {
      const org = this.orgs.get(route[1]);
      if (!org) return this.send(res, 404, null);
      org.can_setup_saml = false;
      return this.send(res, 200, {});
    }

    return this.send(res, 404, null);
  }

  _createUser(body) {
    this.counter += 1;
    const user_id = uuid(`${body.email}:${this.counter}`);
    const user = {
      user_id,
      email: body.email,
      email_confirmed: Boolean(body.email_confirmed),
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      username: body.username || null,
      picture_url: body.picture_url || null,
      locked: false,
      enabled: true,
      mfa_enabled: false,
      can_create_orgs: false,
      has_password: Boolean(body.password),
      update_password_required: Boolean(body.ask_user_to_update_password_on_login),
      legacy_user_id: body.legacy_user_id || "",
      created_at: Math.floor(Date.now() / 1000),
      last_active_at: Math.floor(Date.now() / 1000),
      properties: clone(body.properties) || {},
      metadata: clone(body.metadata) || null,
      password: body.password || null,
      org_id_to_org_info: {},
    };
    this.users.set(user_id, user);
    if (body.email) this.byEmail.set(body.email, user_id);
    return user;
  }

  _publicUser(user) {
    const out = clone(user);
    delete out.password;
    return out;
  }

  _listOrg(org) {
    return {
      org_id: org.org_id,
      name: org.name,
      is_saml_configured: org.is_saml_configured,
      max_users: org.max_users,
      custom_role_mapping_name: org.custom_role_mapping_name,
      legacy_org_id: org.legacy_org_id,
      isolated: org.isolated,
      metadata: org.metadata,
      created_at: org.created_at,
    };
  }

  _fullOrg(org) {
    return clone(org);
  }

  root() {
    return { name: "propelauth", version: "1", protocol: "propelauth-backend", documentation: "/docs/propelauth.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => { data += c.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { user_facing_error: "Invalid JSON in request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { user_facing_error: "Invalid JSON in request body" });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }

  sendText(res, status, text) {
    res.setHeader("Content-Type", "text/plain");
    res.statusCode = status;
    res.end(text);
  }
}

const SENTINEL_BAD_JSON = Symbol("bad-json");
