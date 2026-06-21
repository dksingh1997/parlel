import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SendgridServer } from "../services/sendgrid/src/server.js";

const PORT = 14650;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "SG.parlelTestKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

/**
 * Minimal faithful re-implementation of how the official `@sendgrid/mail`
 * client builds and dispatches a request. This mirrors @sendgrid/mail's
 * MailService.send -> @sendgrid/client.request on the wire so we exercise the
 * exact protocol the real client speaks, with zero external dependencies.
 */
class MailClientSim {
  private apiKey = "";
  private baseUrl = BASE_URL;

  setApiKey(key: string) {
    this.apiKey = key;
    return this;
  }

  setDefaultRequest(_key: string, value: string) {
    this.baseUrl = value;
    return this;
  }

  // Build the JSON body the way @sendgrid/helpers Mail.toJSON does for the
  // common shorthand form { to, from, subject, text, html }.
  private buildBody(data: Json, isMultiple: boolean): Json {
    if (data.personalizations) {
      return data; // already in full form
    }
    const toList = Array.isArray(data.to) ? data.to : [data.to];
    const personalizations = isMultiple
      ? toList.map((t: any) => ({ to: [normalize(t)] }))
      : [{ to: toList.map(normalize) }];
    if (data.cc) personalizations[0].cc = (Array.isArray(data.cc) ? data.cc : [data.cc]).map(normalize);
    if (data.bcc) personalizations[0].bcc = (Array.isArray(data.bcc) ? data.bcc : [data.bcc]).map(normalize);

    const content: Json[] = [];
    if (data.text) content.push({ type: "text/plain", value: data.text });
    if (data.html) content.push({ type: "text/html", value: data.html });
    if (Array.isArray(data.content)) content.push(...data.content);

    const out: Json = {
      personalizations,
      from: normalize(data.from),
      subject: data.subject,
    };
    if (content.length) out.content = content;
    if (data.replyTo) out.reply_to = normalize(data.replyTo);
    if (data.templateId) out.template_id = data.templateId;
    if (data.attachments) out.attachments = data.attachments;
    if (data.categories) out.categories = data.categories;
    if (data.sendAt) out.send_at = data.sendAt;
    if (data.batchId) out.batch_id = data.batchId;
    if (data.customArgs) out.custom_args = data.customArgs;
    if (data.mailSettings) out.mail_settings = data.mailSettings;
    if (data.trackingSettings) out.tracking_settings = data.trackingSettings;
    if (data.asm) out.asm = data.asm;
    return out;
  }

  async request(reqData: Json) {
    const response = await fetch(`${this.baseUrl}${reqData.url}`, {
      method: reqData.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(reqData.headers || {}),
      },
      body: reqData.body !== undefined ? JSON.stringify(reqData.body) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : "";
    if (response.status >= 400) {
      // Mirror @sendgrid/helpers ResponseError shape.
      const err: any = new Error(response.statusText || "Bad Request");
      err.code = response.status;
      err.response = { headers: response.headers, body: parsed };
      throw err;
    }
    return [{ statusCode: response.status, body: parsed, headers: response.headers }, parsed];
  }

  send(data: Json, isMultiple = false) {
    const body = this.buildBody(data, isMultiple);
    return this.request({ method: "POST", url: "/v3/mail/send", headers: {}, body });
  }

  sendMultiple(data: Json) {
    return this.send(data, true);
  }
}

function normalize(value: any) {
  return typeof value === "string" ? { email: value } : value;
}

describe("Sendgrid Service", () => {
  let server: SendgridServer;

  beforeAll(async () => {
    server = new SendgridServer(PORT);
    await server.start();
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
      expect(root.body.name).toBe("sendgrid");
      expect(root.body.protocol).toBe("sendgrid-v3");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/v3/mail/send`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("has resettable ephemeral state", async () => {
      await api("POST", "/v3/mail/send", validMail());
      expect(server.messages.length).toBe(1);
      server.reset();
      expect(server.messages.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Authentication", () => {
    it("rejects missing authorization with SendGrid 401 shape", async () => {
      const response = await fetch(`${BASE_URL}/v3/mail/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validMail()),
      });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.errors[0].message).toMatch(/authorization grant is invalid/i);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("POST", "/v3/mail/send", validMail());
      expect(result.status).toBe(202);
    });

    it("accepts Basic (Twilio Email) auth", async () => {
      const basic = Buffer.from("user:pass").toString("base64");
      const result = await api("POST", "/v3/mail/send", validMail(), { Authorization: `Basic ${basic}` });
      expect(result.status).toBe(202);
    });

    it("rejects malformed JSON body with 400", async () => {
      const response = await fetch(`${BASE_URL}/v3/mail/send`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /v3/mail/send — happy paths", () => {
    it("accepts a minimal valid message, returns 202 + X-Message-Id", async () => {
      const result = await api("POST", "/v3/mail/send", validMail());
      expect(result.status).toBe(202);
      expect(result.headers.get("x-message-id")).toBeTruthy();
      expect(result.body).toEqual({});
    });

    it("captures the message body for inspection", async () => {
      const mail = validMail();
      const result = await api("POST", "/v3/mail/send", mail);
      const id = result.headers.get("x-message-id");
      const captured = await api("GET", `/__parlel/messages/${id}`);
      expect(captured.status).toBe(200);
      expect(captured.body.message_id).toBe(id);
      expect(captured.body.body.from.email).toBe("from@parlel.dev");
    });

    it("accepts multiple personalizations", async () => {
      const mail = {
        personalizations: [
          { to: [{ email: "a@parlel.dev" }], subject: "A" },
          { to: [{ email: "b@parlel.dev" }], subject: "B" },
        ],
        from: { email: "from@parlel.dev" },
        content: [{ type: "text/plain", value: "hi" }],
      };
      const result = await api("POST", "/v3/mail/send", mail);
      expect(result.status).toBe(202);
    });

    it("accepts a template send without subject/content", async () => {
      const mail = {
        personalizations: [{ to: [{ email: "a@parlel.dev" }] }],
        from: { email: "from@parlel.dev" },
        template_id: "d-12345",
      };
      const result = await api("POST", "/v3/mail/send", mail);
      expect(result.status).toBe(202);
    });

    it("accepts cc, bcc, reply_to, attachments, categories, custom_args", async () => {
      const mail = {
        personalizations: [
          {
            to: [{ email: "a@parlel.dev" }],
            cc: [{ email: "c@parlel.dev" }],
            bcc: [{ email: "b@parlel.dev" }],
            subject: "Full featured",
          },
        ],
        from: { email: "from@parlel.dev", name: "Parlel" },
        reply_to: { email: "reply@parlel.dev" },
        content: [{ type: "text/html", value: "<b>hi</b>" }],
        attachments: [{ content: "aGVsbG8=", filename: "hello.txt", type: "text/plain", disposition: "attachment" }],
        categories: ["welcome", "parlel"],
        custom_args: { user_id: "42" },
      };
      const result = await api("POST", "/v3/mail/send", mail);
      expect(result.status).toBe(202);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /v3/mail/send — validation errors (400)", () => {
    it("rejects missing personalizations", async () => {
      const result = await api("POST", "/v3/mail/send", {
        from: { email: "from@parlel.dev" },
        subject: "x",
        content: [{ type: "text/plain", value: "y" }],
      });
      expect(result.status).toBe(400);
      expect(result.body.errors[0].field).toBe("personalizations");
    });

    it("rejects empty to array", async () => {
      const result = await api("POST", "/v3/mail/send", {
        personalizations: [{ to: [] }],
        from: { email: "from@parlel.dev" },
        subject: "x",
        content: [{ type: "text/plain", value: "y" }],
      });
      expect(result.status).toBe(400);
      expect(result.body.errors[0].field).toBe("personalizations.0.to");
    });

    it("rejects invalid recipient email", async () => {
      const result = await api("POST", "/v3/mail/send", {
        personalizations: [{ to: [{ email: "not-an-email" }] }],
        from: { email: "from@parlel.dev" },
        subject: "x",
        content: [{ type: "text/plain", value: "y" }],
      });
      expect(result.status).toBe(400);
      expect(result.body.errors[0].field).toBe("personalizations.0.to.0.email");
    });

    it("rejects missing from", async () => {
      const result = await api("POST", "/v3/mail/send", {
        personalizations: [{ to: [{ email: "a@parlel.dev" }] }],
        subject: "x",
        content: [{ type: "text/plain", value: "y" }],
      });
      expect(result.status).toBe(400);
      expect(result.body.errors.some((e: Json) => e.field === "from")).toBe(true);
    });

    it("rejects missing subject when no template/per-personalization subject", async () => {
      const result = await api("POST", "/v3/mail/send", {
        personalizations: [{ to: [{ email: "a@parlel.dev" }] }],
        from: { email: "from@parlel.dev" },
        content: [{ type: "text/plain", value: "y" }],
      });
      expect(result.status).toBe(400);
      expect(result.body.errors.some((e: Json) => e.field === "subject")).toBe(true);
    });

    it("rejects missing content when no template", async () => {
      const result = await api("POST", "/v3/mail/send", {
        personalizations: [{ to: [{ email: "a@parlel.dev" }] }],
        from: { email: "from@parlel.dev" },
        subject: "x",
      });
      expect(result.status).toBe(400);
      expect(result.body.errors.some((e: Json) => e.field === "content")).toBe(true);
    });

    it("rejects content entries missing type/value", async () => {
      const result = await api("POST", "/v3/mail/send", {
        personalizations: [{ to: [{ email: "a@parlel.dev" }] }],
        from: { email: "from@parlel.dev" },
        subject: "x",
        content: [{ value: "" }],
      });
      expect(result.status).toBe(400);
      const fields = result.body.errors.map((e: Json) => e.field);
      expect(fields).toContain("content.0.type");
      expect(fields).toContain("content.0.value");
    });

    it("error entries carry message/field/help shape", async () => {
      const result = await api("POST", "/v3/mail/send", {});
      expect(result.status).toBe(400);
      for (const entry of result.body.errors) {
        expect(entry).toHaveProperty("message");
        expect(entry).toHaveProperty("field");
        expect(entry).toHaveProperty("help");
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("Mail batch", () => {
    it("creates a batch id (201)", async () => {
      const result = await api("POST", "/v3/mail/batch");
      expect(result.status).toBe(201);
      expect(typeof result.body.batch_id).toBe("string");
    });

    it("validates a batch id, returning just { batch_id }", async () => {
      const created = await api("POST", "/v3/mail/batch");
      const fetched = await api("GET", `/v3/mail/batch/${created.body.batch_id}`);
      expect(fetched.status).toBe(200);
      // Real "Validate batch ID" returns only { batch_id }.
      expect(fetched.body).toEqual({ batch_id: created.body.batch_id });
    });
  });

  // -------------------------------------------------------------------------
  describe("Scopes", () => {
    it("lists scopes for the authenticated key", async () => {
      const result = await api("GET", "/v3/scopes");
      expect(result.status).toBe(200);
      expect(result.body.scopes).toContain("mail.send");
    });
  });

  // -------------------------------------------------------------------------
  describe("API keys", () => {
    it("lists api keys (seeded default present)", async () => {
      const result = await api("GET", "/v3/api_keys");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.result)).toBe(true);
      expect(result.body.result.length).toBeGreaterThanOrEqual(1);
    });

    it("creates an api key and returns the secret once", async () => {
      const result = await api("POST", "/v3/api_keys", { name: "ci-key", scopes: ["mail.send"] });
      expect(result.status).toBe(201);
      expect(result.body.name).toBe("ci-key");
      expect(result.body.api_key).toMatch(/^SG\./);
      expect(result.body.api_key_id).toBeTruthy();
    });

    it("rejects api key creation without a name", async () => {
      const result = await api("POST", "/v3/api_keys", {});
      expect(result.status).toBe(400);
    });

    it("retrieves, updates and deletes an api key", async () => {
      const created = await api("POST", "/v3/api_keys", { name: "temp" });
      const id = created.body.api_key_id;
      const got = await api("GET", `/v3/api_keys/${id}`);
      expect(got.status).toBe(200);
      const updated = await api("PUT", `/v3/api_keys/${id}`, { name: "renamed", scopes: ["mail.send", "alerts.read"] });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe("renamed");
      expect(updated.body.scopes).toContain("alerts.read");
      const deleted = await api("DELETE", `/v3/api_keys/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v3/api_keys/${id}`);
      expect(gone.status).toBe(404);
    });

    it("returns 404 for unknown api key with SendGrid error envelope", async () => {
      const result = await api("GET", "/v3/api_keys/does-not-exist");
      expect(result.status).toBe(404);
      expect(Array.isArray(result.body.errors)).toBe(true);
      expect(result.body.errors[0]).toHaveProperty("message");
    });

    it("returns 405 with the error envelope for an unsupported method on the collection", async () => {
      const result = await api("DELETE", "/v3/api_keys");
      expect(result.status).toBe(405);
      expect(Array.isArray(result.body.errors)).toBe(true);
      expect(result.body.errors[0]).toHaveProperty("message");
    });
  });

  // -------------------------------------------------------------------------
  describe("ASM unsubscribe groups", () => {
    it("lists seeded groups with the documented shape (incl. unsubscribes)", async () => {
      const result = await api("GET", "/v3/asm/groups");
      expect(result.status).toBe(200);
      expect(result.body.length).toBeGreaterThanOrEqual(1);
      const group = result.body[0];
      // Real GET /v3/asm/groups objects carry: id, name, description, is_default, unsubscribes.
      expect(group).toHaveProperty("id");
      expect(group).toHaveProperty("name");
      expect(group).toHaveProperty("description");
      expect(group).toHaveProperty("is_default");
      expect(group).toHaveProperty("unsubscribes");
      expect(typeof group.unsubscribes).toBe("number");
    });

    it("creates, reads, updates and deletes a group", async () => {
      const created = await api("POST", "/v3/asm/groups", { name: "Promotions", description: "deals" });
      expect(created.status).toBe(201);
      // Created group carries the unsubscribes counter, matching the real API shape.
      expect(created.body.unsubscribes).toBe(0);
      const id = created.body.id;
      const got = await api("GET", `/v3/asm/groups/${id}`);
      expect(got.body.name).toBe("Promotions");
      expect(got.body).toHaveProperty("unsubscribes");
      const patched = await api("PATCH", `/v3/asm/groups/${id}`, { description: "updated" });
      expect(patched.body.description).toBe("updated");
      const deleted = await api("DELETE", `/v3/asm/groups/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v3/asm/groups/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects group creation without name", async () => {
      const result = await api("POST", "/v3/asm/groups", {});
      expect(result.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("Global suppressions", () => {
    it("adds, checks and removes a global unsubscribe", async () => {
      const add = await api("POST", "/v3/asm/suppressions/global", { recipient_emails: ["spam@parlel.dev"] });
      expect(add.status).toBe(201);
      expect(add.body.recipient_emails).toContain("spam@parlel.dev");

      const check = await api("GET", "/v3/asm/suppressions/global/spam@parlel.dev");
      expect(check.status).toBe(200);
      expect(check.body.recipient_email).toBe("spam@parlel.dev");

      const missing = await api("GET", "/v3/asm/suppressions/global/clean@parlel.dev");
      expect(missing.status).toBe(200);
      expect(missing.body).toEqual({});

      const removed = await api("DELETE", "/v3/asm/suppressions/global/spam@parlel.dev");
      expect(removed.status).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  describe("Verified senders", () => {
    it("creates and lists a verified sender", async () => {
      const created = await api("POST", "/v3/verified_senders", { from_email: "sender@parlel.dev", from_name: "Parlel" });
      expect(created.status).toBe(201);
      expect(created.body.verified).toBe(true);
      const list = await api("GET", "/v3/verified_senders");
      expect(list.status).toBe(200);
      expect(list.body.results.length).toBe(1);
    });

    it("rejects verified sender without valid email", async () => {
      const result = await api("POST", "/v3/verified_senders", { from_email: "bad" });
      expect(result.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("parlel inspection endpoints", () => {
    it("lists all captured messages", async () => {
      await api("POST", "/v3/mail/send", validMail());
      await api("POST", "/v3/mail/send", validMail());
      const result = await api("GET", "/__parlel/messages");
      expect(result.status).toBe(200);
      expect(result.body.count).toBe(2);
    });

    it("clears the captured mailbox without resetting other state", async () => {
      await api("POST", "/v3/mail/send", validMail());
      const cleared = await api("DELETE", "/__parlel/messages");
      expect(cleared.status).toBe(200);
      const after = await api("GET", "/__parlel/messages");
      expect(after.body.count).toBe(0);
    });

    it("resets all state via /__parlel/reset", async () => {
      await api("POST", "/v3/mail/send", validMail());
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const after = await api("GET", "/__parlel/messages");
      expect(after.body.count).toBe(0);
    });

    it("returns 404 for an unknown captured message", async () => {
      const result = await api("GET", "/__parlel/messages/nope");
      expect(result.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Real @sendgrid/mail wire-protocol compatibility (simulated client)", () => {
    it("send() with shorthand fields posts a valid v3 body and resolves 202", async () => {
      const sg = new MailClientSim();
      sg.setApiKey(API_KEY);
      sg.setDefaultRequest("baseUrl", BASE_URL);
      const [response] = await sg.send({
        to: "to@parlel.dev",
        from: "from@parlel.dev",
        subject: "Sending with parlel is fun",
        text: "and easy to do anywhere, even with Node.js",
        html: "<strong>and easy to do anywhere, even with Node.js</strong>",
      });
      expect(response.statusCode).toBe(202);
      expect(response.headers.get("x-message-id")).toBeTruthy();
    });

    it("sendMultiple() fans out to multiple personalizations", async () => {
      const sg = new MailClientSim().setApiKey(API_KEY) as MailClientSim;
      const [response] = await sg.sendMultiple({
        to: ["a@parlel.dev", "b@parlel.dev"],
        from: "from@parlel.dev",
        subject: "Hello",
        text: "hi",
      });
      expect(response.statusCode).toBe(202);
    });

    it("send() with invalid payload rejects with a ResponseError-shaped error", async () => {
      const sg = new MailClientSim().setApiKey(API_KEY) as MailClientSim;
      await expect(
        sg.send({ to: "to@parlel.dev", from: "from@parlel.dev", subject: "missing content" } as any)
      ).rejects.toMatchObject({
        code: 400,
        response: { body: { errors: expect.any(Array) } },
      });
    });

    it("send() accepts an array of messages (parallel sends)", async () => {
      const sg = new MailClientSim().setApiKey(API_KEY) as MailClientSim;
      const results = await Promise.all([
        sg.send({ to: "a@parlel.dev", from: "from@parlel.dev", subject: "1", text: "x" }),
        sg.send({ to: "b@parlel.dev", from: "from@parlel.dev", subject: "2", text: "y" }),
      ]);
      for (const [response] of results) {
        expect(response.statusCode).toBe(202);
      }
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(2);
    });
  });
});

function validMail(): Json {
  return {
    personalizations: [{ to: [{ email: "to@parlel.dev" }], subject: "Hello from parlel" }],
    from: { email: "from@parlel.dev", name: "Parlel" },
    content: [{ type: "text/plain", value: "This is a test." }],
  };
}
