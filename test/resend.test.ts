import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ResendServer } from "../services/resend/src/server.js";

const PORT = 14651;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "re_parlelTestKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: any, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

/**
 * Minimal faithful re-implementation of how the official `resend` Node.js SDK
 * builds and dispatches requests. The real SDK exposes `resend.emails`,
 * `resend.batch`, `resend.domains`, `resend.apiKeys`, `resend.audiences`,
 * `resend.contacts`, and `resend.broadcasts`, each delegating to an internal
 * fetch-based transport that returns `{ data, error }`. This mirrors that
 * shape on the wire so we exercise the exact protocol the real client speaks,
 * with zero external dependencies.
 */
class ResendClientSim {
  constructor(private apiKey: string, private baseUrl = BASE_URL) {}

  private async request(method: string, path: string, body?: any, extraHeaders: Json = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "User-Agent": "resend-node:sim",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (response.status >= 400) {
      // The real SDK resolves with { data: null, error } instead of throwing.
      return { data: null, error: parsed };
    }
    return { data: parsed, error: null };
  }

  emails = {
    send: (payload: Json, options: Json = {}) =>
      this.request("POST", "/emails", payload, options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    get: (id: string) => this.request("GET", `/emails/${id}`),
    update: (payload: Json) => this.request("PATCH", `/emails/${payload.id}`, payload),
    cancel: (id: string) => this.request("POST", `/emails/${id}/cancel`),
  };

  batch = {
    send: (payload: Json[]) => this.request("POST", "/emails/batch", payload),
  };

  domains = {
    create: (payload: Json) => this.request("POST", "/domains", payload),
    list: () => this.request("GET", "/domains"),
    get: (id: string) => this.request("GET", `/domains/${id}`),
    update: (payload: Json) => this.request("PATCH", `/domains/${payload.id}`, payload),
    verify: (id: string) => this.request("POST", `/domains/${id}/verify`),
    remove: (id: string) => this.request("DELETE", `/domains/${id}`),
  };

  apiKeys = {
    create: (payload: Json) => this.request("POST", "/api-keys", payload),
    list: () => this.request("GET", "/api-keys"),
    remove: (id: string) => this.request("DELETE", `/api-keys/${id}`),
  };

  audiences = {
    create: (payload: Json) => this.request("POST", "/audiences", payload),
    list: () => this.request("GET", "/audiences"),
    get: (id: string) => this.request("GET", `/audiences/${id}`),
    remove: (id: string) => this.request("DELETE", `/audiences/${id}`),
  };

  contacts = {
    create: (payload: Json) => this.request("POST", `/audiences/${payload.audienceId}/contacts`, payload),
    list: (opts: Json) => this.request("GET", `/audiences/${opts.audienceId}/contacts`),
    get: (opts: Json) => this.request("GET", `/audiences/${opts.audienceId}/contacts/${opts.id ?? opts.email}`),
    update: (payload: Json) => this.request("PATCH", `/audiences/${payload.audienceId}/contacts/${payload.id ?? payload.email}`, payload),
    remove: (opts: Json) => this.request("DELETE", `/audiences/${opts.audienceId}/contacts/${opts.id ?? opts.email}`),
  };

  broadcasts = {
    create: (payload: Json) => this.request("POST", "/broadcasts", payload),
    list: () => this.request("GET", "/broadcasts"),
    get: (id: string) => this.request("GET", `/broadcasts/${id}`),
    update: (payload: Json) => this.request("PATCH", `/broadcasts/${payload.id}`, payload),
    send: (id: string, payload: Json = {}) => this.request("POST", `/broadcasts/${id}/send`, payload),
    remove: (id: string) => this.request("DELETE", `/broadcasts/${id}`),
  };
}

function validEmail(): Json {
  return {
    from: "Acme <onboarding@resend.dev>",
    to: ["delivered@resend.dev"],
    subject: "hello world",
    html: "<p>it works!</p>",
  };
}

describe("Resend Service", () => {
  let server: ResendServer;
  let client: ResendClientSim;

  beforeAll(async () => {
    server = new ResendServer(PORT);
    await server.start();
    client = new ResendClientSim(API_KEY);
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // -------------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("resend");
      expect(root.body.protocol).toBe("resend-rest");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/emails`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("has resettable ephemeral state", async () => {
      await api("POST", "/emails", validEmail());
      expect(server.emails.size).toBe(1);
      server.reset();
      expect(server.emails.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Authentication", () => {
    it("rejects missing authorization with Resend 401 shape", async () => {
      const response = await fetch(`${BASE_URL}/emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validEmail()),
      });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.name).toBe("missing_api_key");
      expect(body.statusCode).toBe(401);
      expect(body.message).toMatch(/Missing API key/i);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("POST", "/emails", validEmail());
      expect(result.status).toBe(200);
    });

    it("rejects malformed JSON body with 400", async () => {
      const response = await fetch(`${BASE_URL}/emails`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(response.status).toBe(400);
    });

    it("returns not_found for unknown endpoints", async () => {
      const result = await api("GET", "/nope");
      expect(result.status).toBe(404);
      expect(result.body.name).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /emails — send (happy paths)", () => {
    it("accepts a minimal valid email and returns an id", async () => {
      const result = await api("POST", "/emails", validEmail());
      expect(result.status).toBe(200);
      expect(typeof result.body.id).toBe("string");
      expect(result.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("accepts a friendly-name from address", async () => {
      const result = await api("POST", "/emails", {
        from: "Acme <onboarding@resend.dev>",
        to: "delivered@resend.dev",
        subject: "hi",
        text: "plain",
      });
      expect(result.status).toBe(200);
    });

    it("accepts cc, bcc, reply_to, headers, tags, attachments", async () => {
      const result = await api("POST", "/emails", {
        from: "onboarding@resend.dev",
        to: ["a@resend.dev", "b@resend.dev"],
        cc: "c@resend.dev",
        bcc: ["d@resend.dev"],
        reply_to: "reply@resend.dev",
        subject: "full featured",
        html: "<b>hi</b>",
        headers: { "X-Entity-Ref-ID": "123" },
        tags: [{ name: "category", value: "confirm_email" }],
        attachments: [{ content: "aGVsbG8=", filename: "hello.txt" }],
      });
      expect(result.status).toBe(200);
    });

    it("accepts a template send without html/text", async () => {
      const result = await api("POST", "/emails", {
        from: "onboarding@resend.dev",
        to: "a@resend.dev",
        subject: "templated",
        template: { id: "tmpl_123", variables: { name: "Sam" } },
      });
      expect(result.status).toBe(200);
    });

    it("accepts a scheduled email and marks last_event scheduled", async () => {
      const result = await api("POST", "/emails", {
        ...validEmail(),
        scheduled_at: "2099-01-01T00:00:00.000Z",
      });
      expect(result.status).toBe(200);
      const got = await api("GET", `/emails/${result.body.id}`);
      expect(got.body.last_event).toBe("scheduled");
      expect(got.body.scheduled_at).toBe("2099-01-01T00:00:00.000Z");
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /emails — validation errors", () => {
    it("rejects missing required fields (422 missing_required_field)", async () => {
      const result = await api("POST", "/emails", { from: "a@resend.dev" });
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("missing_required_field");
    });

    it("rejects an invalid from address (422 invalid_from_address)", async () => {
      const result = await api("POST", "/emails", {
        from: "not-an-email",
        to: "a@resend.dev",
        subject: "x",
        text: "y",
      });
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("invalid_from_address");
    });

    it("rejects invalid recipient addresses (400 validation_error)", async () => {
      const result = await api("POST", "/emails", {
        from: "a@resend.dev",
        to: "not-an-email",
        subject: "x",
        text: "y",
      });
      // Real Resend returns 400 for generic `validation_error` (only the typed
      // errors like missing_required_field use 422).
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("validation_error");
    });

    it("rejects when neither content nor template provided (400)", async () => {
      const result = await api("POST", "/emails", {
        from: "a@resend.dev",
        to: "b@resend.dev",
        subject: "x",
      });
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("validation_error");
    });

    it("rejects template + html together (400)", async () => {
      const result = await api("POST", "/emails", {
        from: "a@resend.dev",
        to: "b@resend.dev",
        subject: "x",
        html: "<p>x</p>",
        template: { id: "t" },
      });
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("validation_error");
    });

    it("rejects attachment without content or path (422 invalid_attachment)", async () => {
      const result = await api("POST", "/emails", {
        ...validEmail(),
        attachments: [{ filename: "x.txt" }],
      });
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("invalid_attachment");
    });
  });

  // -------------------------------------------------------------------------
  describe("Idempotency-Key", () => {
    it("replays the same response for a repeated idempotency key", async () => {
      const first = await api("POST", "/emails", validEmail(), { ...AUTH, "Idempotency-Key": "key-123" });
      const second = await api("POST", "/emails", validEmail(), { ...AUTH, "Idempotency-Key": "key-123" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(server.emails.size).toBe(1);
    });

    it("rejects an over-length idempotency key (400)", async () => {
      const long = "k".repeat(257);
      const result = await api("POST", "/emails", validEmail(), { ...AUTH, "Idempotency-Key": long });
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("invalid_idempotency_key");
    });
  });

  // -------------------------------------------------------------------------
  describe("GET /emails/:id — retrieve", () => {
    it("retrieves a sent email with the documented shape", async () => {
      const sent = await api("POST", "/emails", validEmail());
      const got = await api("GET", `/emails/${sent.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.object).toBe("email");
      expect(got.body.id).toBe(sent.body.id);
      expect(got.body.to).toEqual(["delivered@resend.dev"]);
      expect(got.body.from).toBe("Acme <onboarding@resend.dev>");
      expect(got.body.last_event).toBe("delivered");
      expect(Array.isArray(got.body.cc)).toBe(true);
      expect(got.body).not.toHaveProperty("_request");
    });

    it("returns 404 for an unknown email id", async () => {
      const got = await api("GET", "/emails/00000000-0000-0000-0000-000000000000");
      expect(got.status).toBe(404);
      expect(got.body.name).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH /emails/:id — update (reschedule)", () => {
    it("updates the scheduled time of an email", async () => {
      const sent = await api("POST", "/emails", { ...validEmail(), scheduled_at: "2099-01-01T00:00:00.000Z" });
      const updated = await api("PATCH", `/emails/${sent.body.id}`, { scheduled_at: "2099-02-02T00:00:00.000Z" });
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ object: "email", id: sent.body.id });
      const got = await api("GET", `/emails/${sent.body.id}`);
      expect(got.body.scheduled_at).toBe("2099-02-02T00:00:00.000Z");
    });

    it("returns 404 updating an unknown email", async () => {
      const updated = await api("PATCH", "/emails/00000000-0000-0000-0000-000000000000", { scheduled_at: "x" });
      expect(updated.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /emails/:id/cancel — cancel", () => {
    it("cancels a scheduled email", async () => {
      const sent = await api("POST", "/emails", { ...validEmail(), scheduled_at: "2099-01-01T00:00:00.000Z" });
      const canceled = await api("POST", `/emails/${sent.body.id}/cancel`);
      expect(canceled.status).toBe(200);
      expect(canceled.body).toEqual({ object: "email", id: sent.body.id });
      const got = await api("GET", `/emails/${sent.body.id}`);
      expect(got.body.last_event).toBe("canceled");
    });

    it("returns 404 canceling an unknown email", async () => {
      const canceled = await api("POST", "/emails/00000000-0000-0000-0000-000000000000/cancel");
      expect(canceled.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /emails/batch — batch send", () => {
    it("sends up to 100 emails and returns an array of ids", async () => {
      const result = await api("POST", "/emails/batch", [
        { from: "onboarding@resend.dev", to: ["foo@gmail.com"], subject: "hello", html: "<h1>1</h1>" },
        { from: "onboarding@resend.dev", to: ["bar@outlook.com"], subject: "world", html: "<p>2</p>" },
      ]);
      expect(result.status).toBe(200);
      expect(result.body.data.length).toBe(2);
      expect(result.body.data[0].id).toBeTruthy();
      expect(server.emails.size).toBe(2);
    });

    it("rejects a non-array body (400 validation_error)", async () => {
      const result = await api("POST", "/emails/batch", { from: "a@resend.dev" });
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("validation_error");
    });

    it("rejects a batch with an invalid email (422 invalid_from_address)", async () => {
      const result = await api("POST", "/emails/batch", [
        { from: "onboarding@resend.dev", to: ["foo@gmail.com"], subject: "ok", html: "<p>1</p>" },
        { from: "bad", to: ["bar@outlook.com"], subject: "no", html: "<p>2</p>" },
      ]);
      // Invalid `from` is a typed 422 error even inside batch.
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("invalid_from_address");
      expect(server.emails.size).toBe(0);
    });

    it("rejects attachments and scheduled_at in batch (400)", async () => {
      const withAtt = await api("POST", "/emails/batch", [
        { ...validEmail(), attachments: [{ content: "x", filename: "f" }] },
      ]);
      expect(withAtt.status).toBe(400);
      expect(withAtt.body.name).toBe("validation_error");
      const withSched = await api("POST", "/emails/batch", [
        { ...validEmail(), scheduled_at: "2099-01-01T00:00:00.000Z" },
      ]);
      expect(withSched.status).toBe(400);
      expect(withSched.body.name).toBe("validation_error");
    });

    it("rejects more than 100 emails (400)", async () => {
      const many = Array.from({ length: 101 }, () => validEmail());
      const result = await api("POST", "/emails/batch", many);
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("validation_error");
    });
  });

  // -------------------------------------------------------------------------
  describe("Domains", () => {
    it("creates a domain with DNS records and status not_started", async () => {
      const created = await api("POST", "/domains", { name: "parlel.dev" });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("parlel.dev");
      expect(created.body.status).toBe("not_started");
      expect(Array.isArray(created.body.records)).toBe(true);
      expect(created.body.region).toBe("us-east-1");
      // Real Resend emits 3 DKIM CNAMEs plus an SPF MX, SPF TXT, and a Tracking
      // CNAME — six records in total.
      const dkim = created.body.records.filter((r: Json) => r.record === "DKIM");
      expect(dkim.length).toBe(3);
      const tracking = created.body.records.find((r: Json) => r.record === "Tracking");
      expect(tracking).toBeTruthy();
      expect(tracking.name).toBe("links.parlel.dev");
    });

    it("rejects domain creation without a name", async () => {
      const result = await api("POST", "/domains", {});
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("missing_required_field");
    });

    it("rejects an invalid region (422 invalid_region)", async () => {
      const result = await api("POST", "/domains", { name: "x.dev", region: "mars-1" });
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("invalid_region");
    });

    it("lists, gets, verifies, updates and deletes a domain", async () => {
      const created = await api("POST", "/domains", { name: "parlel.dev", region: "eu-west-1" });
      const id = created.body.id;

      const list = await api("GET", "/domains");
      expect(list.body.data.length).toBe(1);

      const got = await api("GET", `/domains/${id}`);
      expect(got.body.id).toBe(id);
      expect(got.body.region).toBe("eu-west-1");

      const verified = await api("POST", `/domains/${id}/verify`);
      expect(verified.status).toBe(200);
      const afterVerify = await api("GET", `/domains/${id}`);
      expect(afterVerify.body.status).toBe("pending");

      const updated = await api("PATCH", `/domains/${id}`, { open_tracking: true, click_tracking: true });
      expect(updated.status).toBe(200);

      const deleted = await api("DELETE", `/domains/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/domains/${id}`);
      expect(gone.status).toBe(404);
    });

    it("returns 404 for an unknown domain", async () => {
      const got = await api("GET", "/domains/unknown");
      expect(got.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("API keys", () => {
    it("lists api keys (seeded default present)", async () => {
      const result = await api("GET", "/api-keys");
      expect(result.status).toBe(200);
      expect(result.body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("creates an api key and returns id, object and the token once", async () => {
      const result = await api("POST", "/api-keys", { name: "Production" });
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
      // Real Resend create-api-key response: { id, object: "api_key", token }.
      expect(result.body.object).toBe("api_key");
      expect(result.body.token).toMatch(/^re_/);
    });

    it("rejects api key creation without a name", async () => {
      const result = await api("POST", "/api-keys", {});
      expect(result.status).toBe(422);
    });

    it("rejects an invalid permission (422 invalid_access)", async () => {
      const result = await api("POST", "/api-keys", { name: "x", permission: "nope" });
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("invalid_access");
    });

    it("deletes an api key", async () => {
      const created = await api("POST", "/api-keys", { name: "temp" });
      const deleted = await api("DELETE", `/api-keys/${created.body.id}`);
      expect(deleted.status).toBe(200);
    });

    it("returns 404 deleting an unknown api key", async () => {
      const deleted = await api("DELETE", "/api-keys/unknown");
      expect(deleted.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Audiences", () => {
    it("creates, lists, gets and deletes an audience", async () => {
      const created = await api("POST", "/audiences", { name: "Registered Users" });
      expect(created.status).toBe(201);
      expect(created.body.object).toBe("audience");
      const id = created.body.id;

      const list = await api("GET", "/audiences");
      expect(list.body.data.length).toBe(1);

      const got = await api("GET", `/audiences/${id}`);
      expect(got.body.name).toBe("Registered Users");

      const deleted = await api("DELETE", `/audiences/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/audiences/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects audience creation without a name", async () => {
      const result = await api("POST", "/audiences", {});
      expect(result.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------------
  describe("Contacts", () => {
    let audienceId: string;

    beforeEach(async () => {
      const created = await api("POST", "/audiences", { name: "Contacts Audience" });
      audienceId = created.body.id;
    });

    it("creates a contact and returns object/id", async () => {
      const result = await api("POST", `/audiences/${audienceId}/contacts`, {
        email: "steve.wozniak@gmail.com",
        first_name: "Steve",
        last_name: "Wozniak",
        unsubscribed: false,
      });
      expect(result.status).toBe(201);
      expect(result.body.object).toBe("contact");
      expect(result.body.id).toBeTruthy();
    });

    it("rejects contact creation without an email", async () => {
      const result = await api("POST", `/audiences/${audienceId}/contacts`, { first_name: "X" });
      expect(result.status).toBe(422);
    });

    it("lists contacts in an audience", async () => {
      await api("POST", `/audiences/${audienceId}/contacts`, { email: "a@resend.dev" });
      await api("POST", `/audiences/${audienceId}/contacts`, { email: "b@resend.dev" });
      const list = await api("GET", `/audiences/${audienceId}/contacts`);
      expect(list.status).toBe(200);
      expect(list.body.object).toBe("list");
      expect(list.body.data.length).toBe(2);
    });

    it("gets, updates and deletes a contact by id", async () => {
      const created = await api("POST", `/audiences/${audienceId}/contacts`, { email: "c@resend.dev", first_name: "C" });
      const id = created.body.id;

      const got = await api("GET", `/audiences/${audienceId}/contacts/${id}`);
      expect(got.body.email).toBe("c@resend.dev");
      // Public contact shape matches the real GET /contacts/:id body: it carries
      // `properties` and must NOT leak the parlel-internal audience id.
      expect(got.body.object).toBe("contact");
      expect(got.body).toHaveProperty("properties");
      expect(got.body).not.toHaveProperty("audience_id");
      expect(got.body).not.toHaveProperty("_audience_id");

      const updated = await api("PATCH", `/audiences/${audienceId}/contacts/${id}`, { unsubscribed: true, last_name: "Lastname" });
      expect(updated.status).toBe(200);
      const afterUpdate = await api("GET", `/audiences/${audienceId}/contacts/${id}`);
      expect(afterUpdate.body.unsubscribed).toBe(true);
      expect(afterUpdate.body.last_name).toBe("Lastname");

      const deleted = await api("DELETE", `/audiences/${audienceId}/contacts/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/audiences/${audienceId}/contacts/${id}`);
      expect(gone.status).toBe(404);
    });

    it("echoes custom properties on the retrieved contact", async () => {
      const created = await api("POST", `/audiences/${audienceId}/contacts`, {
        email: "props@resend.dev",
        properties: { company_name: "Acme Corp", department: "Engineering" },
      });
      const got = await api("GET", `/audiences/${audienceId}/contacts/${created.body.id}`);
      expect(got.body.properties).toEqual({ company_name: "Acme Corp", department: "Engineering" });
    });

    it("supports lookup by email address", async () => {
      await api("POST", `/audiences/${audienceId}/contacts`, { email: "lookup@resend.dev" });
      const got = await api("GET", `/audiences/${audienceId}/contacts/lookup@resend.dev`);
      expect(got.status).toBe(200);
      expect(got.body.email).toBe("lookup@resend.dev");
    });

    it("returns 404 for contacts under an unknown audience", async () => {
      const result = await api("GET", "/audiences/unknown/contacts");
      expect(result.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Broadcasts", () => {
    it("creates a draft broadcast", async () => {
      const result = await api("POST", "/broadcasts", {
        audience_id: "aud_1",
        from: "Acme <onboarding@resend.dev>",
        subject: "hello world",
        html: "Hi {{{FIRST_NAME}}}",
      });
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
      const got = await api("GET", `/broadcasts/${result.body.id}`);
      expect(got.body.status).toBe("draft");
    });

    it("creates and sends immediately when send=true", async () => {
      const result = await api("POST", "/broadcasts", {
        from: "onboarding@resend.dev",
        subject: "now",
        html: "<p>x</p>",
        send: true,
      });
      const got = await api("GET", `/broadcasts/${result.body.id}`);
      expect(got.body.status).toBe("sent");
    });

    it("rejects scheduled_at without send=true (400 validation_error)", async () => {
      const result = await api("POST", "/broadcasts", {
        from: "onboarding@resend.dev",
        subject: "later",
        html: "<p>x</p>",
        scheduled_at: "in 1 hour",
      });
      expect(result.status).toBe(400);
      expect(result.body.name).toBe("validation_error");
    });

    it("rejects broadcast creation without from/subject", async () => {
      const result = await api("POST", "/broadcasts", { html: "<p>x</p>" });
      expect(result.status).toBe(422);
      expect(result.body.name).toBe("missing_required_field");
    });

    it("lists, updates, sends and deletes a broadcast", async () => {
      const created = await api("POST", "/broadcasts", {
        from: "onboarding@resend.dev",
        subject: "draft",
        html: "<p>x</p>",
      });
      const id = created.body.id;

      const list = await api("GET", "/broadcasts");
      expect(list.body.data.length).toBe(1);

      const updated = await api("PATCH", `/broadcasts/${id}`, { subject: "updated subject" });
      expect(updated.status).toBe(200);

      const sent = await api("POST", `/broadcasts/${id}/send`);
      expect(sent.status).toBe(200);
      const afterSend = await api("GET", `/broadcasts/${id}`);
      expect(afterSend.body.status).toBe("sent");

      // Cannot delete a sent broadcast.
      const blockedDelete = await api("DELETE", `/broadcasts/${id}`);
      expect(blockedDelete.status).toBe(400);
      expect(blockedDelete.body.name).toBe("validation_error");
    });

    it("schedules a broadcast send for later", async () => {
      const created = await api("POST", "/broadcasts", {
        from: "onboarding@resend.dev",
        subject: "draft",
        html: "<p>x</p>",
      });
      const sent = await api("POST", `/broadcasts/${created.body.id}/send`, { scheduled_at: "in 1 hour" });
      expect(sent.status).toBe(200);
      const got = await api("GET", `/broadcasts/${created.body.id}`);
      expect(got.body.status).toBe("queued");
      expect(got.body.scheduled_at).toBe("in 1 hour");
    });

    it("deletes a draft broadcast", async () => {
      const created = await api("POST", "/broadcasts", {
        from: "onboarding@resend.dev",
        subject: "draft",
        html: "<p>x</p>",
      });
      const deleted = await api("DELETE", `/broadcasts/${created.body.id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/broadcasts/${created.body.id}`);
      expect(gone.status).toBe(404);
    });

    it("returns 404 for unknown broadcast", async () => {
      const got = await api("GET", "/broadcasts/unknown");
      expect(got.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("parlel inspection endpoints", () => {
    it("lists all captured emails with full request preserved", async () => {
      await api("POST", "/emails", validEmail());
      await api("POST", "/emails", validEmail());
      const result = await api("GET", "/__parlel/emails");
      expect(result.status).toBe(200);
      expect(result.body.count).toBe(2);
      expect(result.body.emails[0]._request.subject).toBe("hello world");
    });

    it("fetches a single captured email by id", async () => {
      const sent = await api("POST", "/emails", validEmail());
      const result = await api("GET", `/__parlel/emails/${sent.body.id}`);
      expect(result.status).toBe(200);
      expect(result.body.id).toBe(sent.body.id);
      expect(result.body._request.from).toBe("Acme <onboarding@resend.dev>");
    });

    it("clears the captured mailbox without resetting other state", async () => {
      await api("POST", "/emails", validEmail());
      await api("POST", "/audiences", { name: "Keep me" });
      const cleared = await api("DELETE", "/__parlel/emails");
      expect(cleared.status).toBe(200);
      const after = await api("GET", "/__parlel/emails");
      expect(after.body.count).toBe(0);
      const audiences = await api("GET", "/audiences");
      expect(audiences.body.data.length).toBe(1);
    });

    it("resets all state via /__parlel/reset", async () => {
      await api("POST", "/emails", validEmail());
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const after = await api("GET", "/__parlel/emails");
      expect(after.body.count).toBe(0);
    });

    it("returns 404 for an unknown captured email", async () => {
      const result = await api("GET", "/__parlel/emails/nope");
      expect(result.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Real `resend` SDK wire-protocol compatibility (simulated client)", () => {
    it("emails.send resolves { data: { id }, error: null }", async () => {
      const { data, error } = await client.emails.send({
        from: "Acme <onboarding@resend.dev>",
        to: ["delivered@resend.dev"],
        subject: "hello world",
        html: "<p>it works!</p>",
      });
      expect(error).toBeNull();
      expect(data.id).toBeTruthy();
    });

    it("emails.send resolves { data: null, error } on validation failure", async () => {
      const { data, error } = await client.emails.send({
        from: "onboarding@resend.dev",
        to: ["delivered@resend.dev"],
        subject: "missing content",
      } as any);
      expect(data).toBeNull();
      expect(error).toMatchObject({ name: "validation_error", statusCode: 400 });
    });

    it("emails.get / emails.update / emails.cancel round-trip", async () => {
      const { data } = await client.emails.send({ ...validEmail(), scheduled_at: "2099-01-01T00:00:00.000Z" } as any);
      const got = await client.emails.get(data.id);
      expect(got.data.id).toBe(data.id);
      const updated = await client.emails.update({ id: data.id, scheduledAt: "2099-03-03T00:00:00.000Z" });
      expect(updated.error).toBeNull();
      const canceled = await client.emails.cancel(data.id);
      expect(canceled.data.id).toBe(data.id);
    });

    it("batch.send fans out to multiple emails", async () => {
      const { data, error } = await client.batch.send([
        { from: "onboarding@resend.dev", to: ["foo@gmail.com"], subject: "1", html: "<h1>1</h1>" },
        { from: "onboarding@resend.dev", to: ["bar@outlook.com"], subject: "2", html: "<p>2</p>" },
      ]);
      expect(error).toBeNull();
      expect(data.data.length).toBe(2);
    });

    it("domains.create/list/get/verify/update/remove via SDK shape", async () => {
      const created = await client.domains.create({ name: "sdk.parlel.dev" });
      expect(created.data.name).toBe("sdk.parlel.dev");
      const id = created.data.id;
      expect((await client.domains.list()).data.data.length).toBe(1);
      expect((await client.domains.get(id)).data.id).toBe(id);
      expect((await client.domains.verify(id)).error).toBeNull();
      expect((await client.domains.update({ id, openTracking: true } as any)).error).toBeNull();
      expect((await client.domains.remove(id)).error).toBeNull();
    });

    it("apiKeys.create/list/remove via SDK shape", async () => {
      const created = await client.apiKeys.create({ name: "sdk-key" });
      expect(created.data.token).toMatch(/^re_/);
      expect((await client.apiKeys.list()).data.data.length).toBeGreaterThanOrEqual(1);
      expect((await client.apiKeys.remove(created.data.id)).error).toBeNull();
    });

    it("audiences + contacts via SDK shape", async () => {
      const audience = await client.audiences.create({ name: "SDK Audience" });
      const audienceId = audience.data.id;
      const contact = await client.contacts.create({ audienceId, email: "sdk@resend.dev", firstName: "S" });
      expect(contact.data.id).toBeTruthy();
      const list = await client.contacts.list({ audienceId });
      expect(list.data.data.length).toBe(1);
      const got = await client.contacts.get({ audienceId, id: contact.data.id });
      expect(got.data.email).toBe("sdk@resend.dev");
      const updated = await client.contacts.update({ audienceId, id: contact.data.id, unsubscribed: true });
      expect(updated.error).toBeNull();
      const removed = await client.contacts.remove({ audienceId, id: contact.data.id });
      expect(removed.error).toBeNull();
    });

    it("broadcasts via SDK shape", async () => {
      const created = await client.broadcasts.create({
        audienceId: "aud_x",
        from: "onboarding@resend.dev",
        subject: "sdk broadcast",
        html: "<p>hi</p>",
      });
      expect(created.data.id).toBeTruthy();
      const id = created.data.id;
      expect((await client.broadcasts.list()).data.data.length).toBe(1);
      expect((await client.broadcasts.update({ id, subject: "new" })).error).toBeNull();
      expect((await client.broadcasts.send(id)).error).toBeNull();
      expect((await client.broadcasts.get(id)).data.status).toBe("sent");
    });

    it("parallel emails.send calls all succeed and are captured", async () => {
      const results = await Promise.all([
        client.emails.send({ from: "onboarding@resend.dev", to: ["a@resend.dev"], subject: "1", text: "x" }),
        client.emails.send({ from: "onboarding@resend.dev", to: ["b@resend.dev"], subject: "2", text: "y" }),
        client.emails.send({ from: "onboarding@resend.dev", to: ["c@resend.dev"], subject: "3", text: "z" }),
      ]);
      for (const r of results) expect(r.error).toBeNull();
      const inbox = await api("GET", "/__parlel/emails");
      expect(inbox.body.count).toBe(3);
    });
  });
});
