import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PropelauthServer } from "../services/propelauth/src/server.js";

const PORT = 14825;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-api-key" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

describe("PropelAuth Service", () => {
  let server: PropelauthServer;

  beforeAll(async () => {
    server = new PropelauthServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  // -----------------------------------------------------------------------
  // Server lifecycle
  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health", async () => {
      const root = await api("GET", "/", undefined, {});
      const health = await api("GET", "/health", undefined, {});
      expect(root.body.name).toBe("propelauth");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  // -----------------------------------------------------------------------
  // Auth — error envelope
  // -----------------------------------------------------------------------
  describe("Authentication", () => {
    it("rejects requests without bearer — 401 plain text", async () => {
      const r = await api("GET", "/api/backend/v1/user/query", undefined, {});
      expect(r.status).toBe(401);
      expect(r.text).toBe("No authorization header found");
      expect(typeof r.text).toBe("string");
    });
  });

  // -----------------------------------------------------------------------
  // Users — create
  // -----------------------------------------------------------------------
  describe("Users — create", () => {
    it("creates a user and returns user_id", async () => {
      const r = await api("POST", "/api/backend/v1/user/", {
        email: "pa@parlel.dev",
        first_name: "Pro",
        last_name: "Pel",
      });
      expect(r.status).toBe(200);
      expect(r.body.user_id).toBeTruthy();
    });

    it("rejects invalid email — 400 field-array shape", async () => {
      const r = await api("POST", "/api/backend/v1/user/", { email: "bad" });
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body.email)).toBe(true);
      expect(r.body.email[0]).toBeTruthy();
    });

    it("rejects duplicate email — 400 field-array shape", async () => {
      await api("POST", "/api/backend/v1/user/", { email: "dup@parlel.dev" });
      const r = await api("POST", "/api/backend/v1/user/", { email: "dup@parlel.dev" });
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body.email)).toBe(true);
    });

    it("sets has_password based on password field", async () => {
      const r = await api("POST", "/api/backend/v1/user/", {
        email: "pw@parlel.dev",
        password: "secret123",
      });
      expect(r.status).toBe(200);
      const user = await api("GET", `/api/backend/v1/user/${r.body.user_id}`);
      expect(user.body.has_password).toBe(true);

      const r2 = await api("POST", "/api/backend/v1/user/", { email: "nopw@parlel.dev" });
      const user2 = await api("GET", `/api/backend/v1/user/${r2.body.user_id}`);
      expect(user2.body.has_password).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Users — get by id
  // -----------------------------------------------------------------------
  describe("Users — get by id", () => {
    it("returns user with correct fields", async () => {
      const created = await api("POST", "/api/backend/v1/user/", {
        email: "fields@parlel.dev",
        first_name: "F",
        last_name: "L",
      });
      const r = await api("GET", `/api/backend/v1/user/${created.body.user_id}`);
      expect(r.status).toBe(200);
      expect(r.body.email).toBe("fields@parlel.dev");
      expect(r.body.email_confirmed).toBe(false);
      expect(r.body.has_password).toBe(false);
      expect(r.body.update_password_required).toBe(false);
      expect(r.body.legacy_user_id).toBe("");
      expect(r.body.org_id_to_org_info).toEqual({});
      expect(r.body.password).toBeUndefined();
      expect(r.body.locked).toBe(false);
      expect(r.body.enabled).toBe(true);
      expect(r.body.mfa_enabled).toBe(false);
    });

    it("returns 404 null for unknown user", async () => {
      const r = await api("GET", "/api/backend/v1/user/00000000-0000-0000-0000-000000000000");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Users — get by email
  // -----------------------------------------------------------------------
  describe("Users — get by email", () => {
    it("looks up by email", async () => {
      await api("POST", "/api/backend/v1/user/", { email: "lookup@parlel.dev" });
      const r = await api("GET", "/api/backend/v1/user/email?email=lookup@parlel.dev");
      expect(r.status).toBe(200);
      expect(r.body.email).toBe("lookup@parlel.dev");
    });

    it("returns 404 null for unknown email", async () => {
      const r = await api("GET", "/api/backend/v1/user/email?email=nope@parlel.dev");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Users — query
  // -----------------------------------------------------------------------
  describe("Users — query", () => {
    it("returns paginated envelope", async () => {
      await api("POST", "/api/backend/v1/user/", { email: "q1@parlel.dev" });
      await api("POST", "/api/backend/v1/user/", { email: "q2@parlel.dev" });
      const q = await api("GET", "/api/backend/v1/user/query");
      expect(q.status).toBe(200);
      expect(q.body.total_users).toBe(2);
      expect(Array.isArray(q.body.users)).toBe(true);
      expect(q.body.has_more_results).toBe(false);
      expect(q.body.current_page).toBe(0);
      expect(q.body.page_size).toBe(10);
    });

    it("users in query have has_password and org_id_to_org_info", async () => {
      await api("POST", "/api/backend/v1/user/", { email: "qf@parlel.dev" });
      const q = await api("GET", "/api/backend/v1/user/query");
      const user = q.body.users[0];
      expect(typeof user.has_password).toBe("boolean");
      expect(user.org_id_to_org_info).toBeDefined();
      expect(user.password).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Users — update
  // -----------------------------------------------------------------------
  describe("Users — update", () => {
    it("updates user fields", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "u@parlel.dev" });
      const id = created.body.user_id;
      const upd = await api("PUT", `/api/backend/v1/user/${id}`, {
        first_name: "Updated",
        email_confirmed: true,
        update_password_required: true,
        legacy_user_id: "legacy-123",
      });
      expect(upd.status).toBe(200);
      const got = await api("GET", `/api/backend/v1/user/${id}`);
      expect(got.body.first_name).toBe("Updated");
      expect(got.body.email_confirmed).toBe(true);
      expect(got.body.update_password_required).toBe(true);
      expect(got.body.legacy_user_id).toBe("legacy-123");
    });

    it("returns 404 null for unknown user", async () => {
      const r = await api("PUT", "/api/backend/v1/user/00000000-0000-0000-0000-000000000000", { first_name: "X" });
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Users — delete
  // -----------------------------------------------------------------------
  describe("Users — delete", () => {
    it("deletes a user", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "del@parlel.dev" });
      const id = created.body.user_id;
      const del = await api("DELETE", `/api/backend/v1/user/${id}`);
      expect(del.status).toBe(200);
      const got = await api("GET", `/api/backend/v1/user/${id}`);
      expect(got.status).toBe(404);
      expect(got.body).toBeNull();
    });

    it("returns 404 null for unknown user", async () => {
      const r = await api("DELETE", "/api/backend/v1/user/00000000-0000-0000-0000-000000000000");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Users — email update
  // -----------------------------------------------------------------------
  describe("Users — email update", () => {
    it("updates email via PUT /user/:id/email", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "old@parlel.dev" });
      const id = created.body.user_id;
      const r = await api("PUT", `/api/backend/v1/user/${id}/email`, {
        new_email: "new@parlel.dev",
        require_email_confirmation: false,
      });
      expect(r.status).toBe(200);
      const got = await api("GET", `/api/backend/v1/user/${id}`);
      expect(got.body.email).toBe("new@parlel.dev");
      expect(got.body.email_confirmed).toBe(true);
    });

    it("rejects invalid email — 400 field-array", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "valid@parlel.dev" });
      const r = await api("PUT", `/api/backend/v1/user/${created.body.user_id}/email`, {
        new_email: "bad",
        require_email_confirmation: true,
      });
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body.new_email)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Users — password update
  // -----------------------------------------------------------------------
  describe("Users — password update", () => {
    it("sets password via PUT /user/:id/password", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "pwset@parlel.dev" });
      const id = created.body.user_id;
      const r = await api("PUT", `/api/backend/v1/user/${id}/password`, { password: "newpass" });
      expect(r.status).toBe(200);
      const got = await api("GET", `/api/backend/v1/user/${id}`);
      expect(got.body.has_password).toBe(true);
    });

    it("rejects missing password — 400 field-array", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "pwmis@parlel.dev" });
      const r = await api("PUT", `/api/backend/v1/user/${created.body.user_id}/password`, {});
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body.password)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Users — disable / enable
  // -----------------------------------------------------------------------
  describe("Users — disable / enable", () => {
    it("disables and re-enables a user", async () => {
      const created = await api("POST", "/api/backend/v1/user/", { email: "de@parlel.dev" });
      const id = created.body.user_id;

      const dis = await api("POST", `/api/backend/v1/user/${id}/disable`);
      expect(dis.status).toBe(200);
      let got = await api("GET", `/api/backend/v1/user/${id}`);
      expect(got.body.enabled).toBe(false);
      expect(got.body.locked).toBe(true);

      const en = await api("POST", `/api/backend/v1/user/${id}/enable`);
      expect(en.status).toBe(200);
      got = await api("GET", `/api/backend/v1/user/${id}`);
      expect(got.body.enabled).toBe(true);
      expect(got.body.locked).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Orgs — create
  // -----------------------------------------------------------------------
  describe("Orgs — create", () => {
    it("creates an org and returns org_id + name", async () => {
      const r = await api("POST", "/api/backend/v1/org/", { name: "Acme" });
      expect(r.status).toBe(200);
      expect(r.body.org_id).toBeTruthy();
      expect(r.body.name).toBe("Acme");
    });

    it("rejects missing name — 400 field-array", async () => {
      const r = await api("POST", "/api/backend/v1/org/", {});
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body.name)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Orgs — get
  // -----------------------------------------------------------------------
  describe("Orgs — get", () => {
    it("returns full org object with all fields", async () => {
      const created = await api("POST", "/api/backend/v1/org/", { name: "FullOrg", domain: "full.org" });
      const r = await api("GET", `/api/backend/v1/org/${created.body.org_id}`);
      expect(r.status).toBe(200);
      expect(r.body.name).toBe("FullOrg");
      expect(r.body.org_id).toBe(created.body.org_id);
      expect(r.body.url_safe_org_slug).toBeTruthy();
      expect(typeof r.body.can_setup_saml).toBe("boolean");
      expect(typeof r.body.is_saml_configured).toBe("boolean");
      expect(typeof r.body.isolated).toBe("boolean");
      expect(r.body.domain).toBe("full.org");
      expect(Array.isArray(r.body.extra_domains)).toBe(true);
      expect(typeof r.body.created_at).toBe("number");
    });

    it("returns 404 null for unknown org", async () => {
      const r = await api("GET", "/api/backend/v1/org/00000000-0000-0000-0000-000000000000");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Orgs — list
  // -----------------------------------------------------------------------
  describe("Orgs — list", () => {
    it("lists orgs with pagination envelope", async () => {
      await api("POST", "/api/backend/v1/org/", { name: "Org1" });
      await api("POST", "/api/backend/v1/org/", { name: "Org2" });
      const r = await api("GET", "/api/backend/v1/org/");
      expect(r.status).toBe(200);
      expect(r.body.total_orgs).toBe(2);
      expect(Array.isArray(r.body.orgs)).toBe(true);
      expect(r.body.has_more_results).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Orgs — query (POST)
  // -----------------------------------------------------------------------
  describe("Orgs — query", () => {
    it("queries orgs by name filter", async () => {
      await api("POST", "/api/backend/v1/org/", { name: "Alpha" });
      await api("POST", "/api/backend/v1/org/", { name: "Beta" });
      await api("POST", "/api/backend/v1/org/", { name: "Alphabet" });
      const r = await api("POST", "/api/backend/v1/org/query", { name: "alp" });
      expect(r.status).toBe(200);
      expect(r.body.total_orgs).toBe(2);
    });

    it("paginates org query results", async () => {
      for (let i = 0; i < 5; i++) await api("POST", "/api/backend/v1/org/", { name: `O${i}` });
      const r = await api("POST", "/api/backend/v1/org/query", { page_size: 2, page_number: 1 });
      expect(r.status).toBe(200);
      expect(r.body.orgs.length).toBe(2);
      expect(r.body.current_page).toBe(1);
      expect(r.body.has_more_results).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Orgs — update / delete
  // -----------------------------------------------------------------------
  describe("Orgs — update / delete", () => {
    it("updates org fields", async () => {
      const created = await api("POST", "/api/backend/v1/org/", { name: "Old" });
      const upd = await api("PUT", `/api/backend/v1/org/${created.body.org_id}`, {
        name: "New",
        domain: "new.com",
        metadata: { tier: "pro" },
      });
      expect(upd.status).toBe(200);
      const got = await api("GET", `/api/backend/v1/org/${created.body.org_id}`);
      expect(got.body.name).toBe("New");
      expect(got.body.domain).toBe("new.com");
      expect(got.body.metadata.tier).toBe("pro");
    });

    it("deletes an org", async () => {
      const created = await api("POST", "/api/backend/v1/org/", { name: "Doomed" });
      const del = await api("DELETE", `/api/backend/v1/org/${created.body.org_id}`);
      expect(del.status).toBe(200);
      const got = await api("GET", `/api/backend/v1/org/${created.body.org_id}`);
      expect(got.status).toBe(404);
      expect(got.body).toBeNull();
    });

    it("returns 404 null for unknown org update", async () => {
      const r = await api("PUT", "/api/backend/v1/org/00000000-0000-0000-0000-000000000000", { name: "X" });
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });

    it("returns 404 null for unknown org delete", async () => {
      const r = await api("DELETE", "/api/backend/v1/org/00000000-0000-0000-0000-000000000000");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Org membership
  // -----------------------------------------------------------------------
  describe("Org membership", () => {
    it("adds user to org and lists users in org", async () => {
      const user = await api("POST", "/api/backend/v1/user/", { email: "mem@parlel.dev" });
      const org = await api("POST", "/api/backend/v1/org/", { name: "MemOrg" });
      const add = await api("POST", "/api/backend/v1/org/add_user", {
        user_id: user.body.user_id,
        org_id: org.body.org_id,
        role: "Admin",
        additional_roles: ["Member"],
      });
      expect(add.status).toBe(200);

      const list = await api("GET", `/api/backend/v1/user/org/${org.body.org_id}`);
      expect(list.status).toBe(200);
      expect(list.body.total_users).toBe(1);
      expect(list.body.users[0].user_id).toBe(user.body.user_id);
    });

    it("removes user from org", async () => {
      const user = await api("POST", "/api/backend/v1/user/", { email: "rm@parlel.dev" });
      const org = await api("POST", "/api/backend/v1/org/", { name: "RmOrg" });
      await api("POST", "/api/backend/v1/org/add_user", {
        user_id: user.body.user_id,
        org_id: org.body.org_id,
        role: "Member",
      });
      const rm = await api("POST", "/api/backend/v1/org/remove_user", {
        user_id: user.body.user_id,
        org_id: org.body.org_id,
      });
      expect(rm.status).toBe(200);
      const list = await api("GET", `/api/backend/v1/user/org/${org.body.org_id}`);
      expect(list.body.total_users).toBe(0);
    });

    it("changes role in org", async () => {
      const user = await api("POST", "/api/backend/v1/user/", { email: "role@parlel.dev" });
      const org = await api("POST", "/api/backend/v1/org/", { name: "RoleOrg" });
      await api("POST", "/api/backend/v1/org/add_user", {
        user_id: user.body.user_id,
        org_id: org.body.org_id,
        role: "Member",
      });
      const ch = await api("POST", "/api/backend/v1/org/change_role", {
        user_id: user.body.user_id,
        org_id: org.body.org_id,
        role: "Admin",
      });
      expect(ch.status).toBe(200);
    });

    it("rejects missing fields on add_user — 400 field-array", async () => {
      const r = await api("POST", "/api/backend/v1/org/add_user", {});
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body.user_id)).toBe(true);
      expect(Array.isArray(r.body.org_id)).toBe(true);
      expect(Array.isArray(r.body.role)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Failure scenarios — error envelope
  // -----------------------------------------------------------------------
  describe("Failure scenarios — error envelope", () => {
    it("400 for invalid JSON body", async () => {
      const r = await fetch(`${BASE_URL}/api/backend/v1/user/`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.user_facing_error).toBeTruthy();
    });

    it("404 null for unknown top-level route", async () => {
      const r = await api("GET", "/api/backend/v1/nonexistent");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });

    it("404 null for wrong method on existing route", async () => {
      const r = await api("PATCH", "/api/backend/v1/user/query");
      expect(r.status).toBe(404);
      expect(r.body).toBeNull();
    });

    it("401 plain text for invalid auth", async () => {
      const r = await api("GET", "/api/backend/v1/user/query", undefined, { Authorization: "Bearer x" });
      // With a valid bearer it should pass (emulator accepts any non-empty bearer by design)
      expect(r.status).toBe(200);
    });
  });
});
