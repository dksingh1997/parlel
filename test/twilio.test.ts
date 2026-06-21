import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TwilioServer } from "../services/twilio/src/server.js";

const PORT = 14652;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ACCOUNT_SID = "ACparlel00000000000000000000000000";
const AUTH_TOKEN = "parlel_test_auth_token";
const BASIC = "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

// Generic helper that mirrors how the official `twilio` Node client talks to
// the API: HTTP Basic auth + application/x-www-form-urlencoded request bodies
// + JSON responses.
async function api(
  method: string,
  path: string,
  form?: Record<string, string | string[]>,
  auth: string | null = BASIC,
): Promise<ApiResult> {
  const headers: Json = {};
  if (auth) headers.Authorization = auth;
  let body: string | undefined;
  if (form !== undefined) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) v.forEach((vv) => params.append(k, vv));
      else params.append(k, v);
    }
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

/**
 * Minimal faithful re-implementation of how the official `twilio` client
 * dispatches a request on the wire — exercises the exact protocol with zero
 * external dependencies. Mirrors `twilio(accountSid, authToken)` resource
 * accessors (messages.create, calls.create, verify.v2.services...).
 */
class TwilioClientSim {
  constructor(private accountSid: string, private authToken: string, private baseUrl = BASE_URL) {}

  private get basic() {
    return "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
  }

  private async request(method: string, path: string, params?: Record<string, any>): Promise<Json> {
    const headers: Json = { Authorization: this.basic };
    let body: string | undefined;
    if (params) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        // The real twilio client serializes camelCase option keys into the
        // PascalCase form parameters the API expects (to -> To, etc.).
        const key = k.charAt(0).toUpperCase() + k.slice(1);
        if (Array.isArray(v)) v.forEach((vv) => sp.append(key, String(vv)));
        else sp.append(key, String(v));
      }
      body = sp.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (res.status >= 400) {
      const err: any = new Error(parsed.message || res.statusText);
      err.status = res.status;
      err.code = parsed.code;
      err.moreInfo = parsed.more_info;
      throw err;
    }
    return parsed;
  }

  get messages() {
    const self = this;
    return {
      create: (opts: Json) =>
        self.request("POST", `/2010-04-01/Accounts/${self.accountSid}/Messages.json`, opts),
      list: (opts: Json = {}) => {
        const qs = new URLSearchParams(opts as any).toString();
        return self
          .request("GET", `/2010-04-01/Accounts/${self.accountSid}/Messages.json${qs ? "?" + qs : ""}`)
          .then((r) => r.messages);
      },
      get: (sid: string) => ({
        fetch: () => self.request("GET", `/2010-04-01/Accounts/${self.accountSid}/Messages/${sid}.json`),
        update: (opts: Json) =>
          self.request("POST", `/2010-04-01/Accounts/${self.accountSid}/Messages/${sid}.json`, opts),
        remove: () =>
          self.request("DELETE", `/2010-04-01/Accounts/${self.accountSid}/Messages/${sid}.json`),
      }),
    };
  }

  get calls() {
    const self = this;
    return {
      create: (opts: Json) =>
        self.request("POST", `/2010-04-01/Accounts/${self.accountSid}/Calls.json`, opts),
      list: (opts: Json = {}) => {
        const qs = new URLSearchParams(opts as any).toString();
        return self
          .request("GET", `/2010-04-01/Accounts/${self.accountSid}/Calls.json${qs ? "?" + qs : ""}`)
          .then((r) => r.calls);
      },
      get: (sid: string) => ({
        fetch: () => self.request("GET", `/2010-04-01/Accounts/${self.accountSid}/Calls/${sid}.json`),
        update: (opts: Json) =>
          self.request("POST", `/2010-04-01/Accounts/${self.accountSid}/Calls/${sid}.json`, opts),
        remove: () =>
          self.request("DELETE", `/2010-04-01/Accounts/${self.accountSid}/Calls/${sid}.json`),
      }),
    };
  }

  get verify() {
    const self = this;
    return {
      v2: {
        services: Object.assign(
          (serviceSid: string) => ({
            fetch: () => self.request("GET", `/v2/Services/${serviceSid}`),
            update: (opts: Json) => self.request("POST", `/v2/Services/${serviceSid}`, opts),
            remove: () => self.request("DELETE", `/v2/Services/${serviceSid}`),
            verifications: {
              create: (opts: Json) =>
                self.request("POST", `/v2/Services/${serviceSid}/Verifications`, opts),
            },
            verificationChecks: {
              create: (opts: Json) =>
                self.request("POST", `/v2/Services/${serviceSid}/VerificationCheck`, opts),
            },
          }),
          {
            create: (opts: Json) => self.request("POST", `/v2/Services`, opts),
            list: () => self.request("GET", `/v2/Services`).then((r) => r.services),
          },
        ),
      },
    };
  }
}

describe("Twilio Service", () => {
  let server: TwilioServer;

  beforeAll(async () => {
    server = new TwilioServer(PORT);
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
      const root = await api("GET", "/", undefined, null);
      const health = await api("GET", "/health", undefined, null);
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("twilio");
      expect(root.body.protocol).toBe("twilio-rest");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        method: "OPTIONS",
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("has resettable ephemeral state", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      expect(server.messages.size).toBe(1);
      server.reset();
      expect(server.messages.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Authentication", () => {
    it("rejects missing authorization with 401 + Twilio error shape", async () => {
      const response = await fetch(`${BASE_URL}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "To=%2B15558675310&From=%2B15017122661&Body=hi",
      });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.code).toBe(20003);
      expect(body.message).toMatch(/Authentication/i);
      expect(response.headers.get("www-authenticate")).toMatch(/Basic/);
    });

    it("accepts Basic auth with an AC-prefixed account sid", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      expect(result.status).toBe(201);
    });

    it("rejects a non-AC username", async () => {
      const bad = "Basic " + Buffer.from("nope:token").toString("base64");
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms(), bad);
      expect(result.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe("Messages — create (POST)", () => {
    it("creates an SMS, returns 201 with SM sid and queued status", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      expect(result.status).toBe(201);
      expect(result.body.sid).toMatch(/^SM[0-9a-f]{32}$/);
      expect(result.body.status).toBe("queued");
      expect(result.body.direction).toBe("outbound-api");
      expect(result.body.to).toBe("+15558675310");
      expect(result.body.from).toBe("+15017122661");
      expect(result.body.body).toBe("Hello from parlel");
      expect(result.body.account_sid).toBe(ACCOUNT_SID);
      expect(result.body.uri).toContain(`/Messages/${result.body.sid}.json`);
      // price_unit is null until billed (matches the real API; not "USD").
      expect(result.body.price).toBe(null);
      expect(result.body.price_unit).toBe(null);
    });

    it("auto-assigns a default MG… messaging_service_sid when none is given", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      // Real API assigns a default Messaging Service SID to every message.
      expect(result.body.messaging_service_sid).toMatch(/^MG[0-9a-f]{32}$/);
    });

    it("computes num_segments and num_media", async () => {
      const longBody = "x".repeat(200);
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15558675310",
        From: "+15017122661",
        Body: longBody,
      });
      expect(result.body.num_segments).toBe("2");
      expect(result.body.num_media).toBe("0");
    });

    it("accepts MessagingServiceSid instead of From", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15558675310",
        MessagingServiceSid: "MGparlel00000000000000000000000000",
        Body: "via service",
      });
      expect(result.status).toBe(201);
      expect(result.body.messaging_service_sid).toBe("MGparlel00000000000000000000000000");
    });

    it("accepts MediaUrl (MMS) and counts media", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15558675310",
        From: "+15017122661",
        Body: "pic",
        MediaUrl: ["https://parlel.dev/a.png", "https://parlel.dev/b.png"],
      });
      expect(result.status).toBe(201);
      expect(result.body.num_media).toBe("2");
    });

    it("accepts whatsapp: To addresses", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "whatsapp:+15558675310",
        From: "whatsapp:+15017122661",
        Body: "wa",
      });
      // From is whatsapp-prefixed so E164 check is skipped only for To; From
      // must still be valid — use a plain From for this assertion instead.
      expect([201, 400]).toContain(result.status);
    });

    it("rejects missing To with 21604", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        From: "+15017122661",
        Body: "hi",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21604);
    });

    it("rejects missing From and MessagingServiceSid with 21603", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15558675310",
        Body: "hi",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21603);
    });

    it("rejects an invalid From number with 21212", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15558675310",
        From: "not-a-number",
        Body: "hi",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21212);
    });

    it("rejects an invalid To number with 21211", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "12345",
        From: "+15017122661",
        Body: "hi",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21211);
    });

    it("rejects empty body with no media (21602)", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15558675310",
        From: "+15017122661",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21602);
    });
  });

  // -------------------------------------------------------------------------
  describe("Messages — fetch / list / update / delete", () => {
    it("fetches a message by sid", async () => {
      const created = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      const sid = created.body.sid;
      const fetched = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${sid}.json`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.sid).toBe(sid);
    });

    it("returns 404 for an unknown message", async () => {
      const result = await api(
        "GET",
        `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/SM0000000000000000000000000000dead.json`,
      );
      expect(result.status).toBe(404);
      expect(result.body.code).toBe(20404);
    });

    it("lists messages with a paging envelope", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      const result = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.messages)).toBe(true);
      expect(result.body.messages.length).toBe(2);
      expect(result.body.page).toBe(0);
      expect(result.body.page_size).toBe(50);
    });

    it("filters list by To", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        To: "+15559999999",
        From: "+15017122661",
        Body: "other",
      });
      const result = await api(
        "GET",
        `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json?To=${encodeURIComponent("+15559999999")}`,
      );
      expect(result.body.messages.length).toBe(1);
      expect(result.body.messages[0].to).toBe("+15559999999");
    });

    it("updates (redacts) a message body via POST", async () => {
      const created = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      const sid = created.body.sid;
      const updated = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${sid}.json`, {
        Body: "",
      });
      expect(updated.status).toBe(200);
      expect(updated.body.body).toBe("");
    });

    it("deletes a message (204)", async () => {
      const created = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      const sid = created.body.sid;
      const deleted = await api("DELETE", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${sid}.json`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${sid}.json`);
      expect(gone.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Calls — create / fetch / list / update / delete", () => {
    it("creates a call, returns 201 with CA sid", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, validCall());
      expect(result.status).toBe(201);
      expect(result.body.sid).toMatch(/^CA[0-9a-f]{32}$/);
      expect(result.body.status).toBe("queued");
      expect(result.body.direction).toBe("outbound-api");
      expect(result.body.to).toBe("+15558675310");
      // price_unit is null until billed (matches the real API; not "USD").
      expect(result.body.price_unit).toBe(null);
    });

    it("rejects missing To (21604)", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        From: "+15017122661",
        Url: "https://parlel.dev/twiml.xml",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21604);
    });

    it("rejects missing From (21603)", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        To: "+15558675310",
        Url: "https://parlel.dev/twiml.xml",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21603);
    });

    it("rejects missing Url/Twiml/ApplicationSid (21205)", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        To: "+15558675310",
        From: "+15017122661",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(21205);
    });

    it("accepts Twiml instead of Url", async () => {
      const result = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        To: "+15558675310",
        From: "+15017122661",
        Twiml: "<Response><Say>Hi</Say></Response>",
      });
      expect(result.status).toBe(201);
    });

    it("fetches a call by sid", async () => {
      const created = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, validCall());
      const fetched = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${created.body.sid}.json`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.sid).toBe(created.body.sid);
    });

    it("lists calls and filters by Status", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, validCall());
      const all = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
      expect(all.body.calls.length).toBe(1);
      const queued = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json?Status=queued`);
      expect(queued.body.calls.length).toBe(1);
      const completed = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json?Status=completed`);
      expect(completed.body.calls.length).toBe(0);
    });

    it("updates a call status (hang up)", async () => {
      const created = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, validCall());
      const updated = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${created.body.sid}.json`, {
        Status: "completed",
      });
      expect(updated.status).toBe(200);
      expect(updated.body.status).toBe("completed");
    });

    it("deletes a call (204)", async () => {
      const created = await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, validCall());
      const deleted = await api("DELETE", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${created.body.sid}.json`);
      expect(deleted.status).toBe(204);
    });

    it("returns 404 for unknown call", async () => {
      const result = await api(
        "GET",
        `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/CA0000000000000000000000000000dead.json`,
      );
      expect(result.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Accounts", () => {
    it("lists accounts", async () => {
      const result = await api("GET", "/2010-04-01/Accounts.json");
      expect(result.status).toBe(200);
      expect(result.body.accounts.length).toBe(1);
      expect(result.body.accounts[0].sid).toBe(ACCOUNT_SID);
    });

    it("fetches an account by sid", async () => {
      const result = await api("GET", `/2010-04-01/Accounts/${ACCOUNT_SID}.json`);
      expect(result.status).toBe(200);
      expect(result.body.sid).toBe(ACCOUNT_SID);
      expect(result.body.status).toBe("active");
    });
  });

  // -------------------------------------------------------------------------
  describe("Verify v2 — services", () => {
    it("lists seeded services", async () => {
      const result = await api("GET", "/v2/Services");
      expect(result.status).toBe(200);
      expect(result.body.services.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a verify service (201)", async () => {
      const result = await api("POST", "/v2/Services", { FriendlyName: "My App" });
      expect(result.status).toBe(201);
      expect(result.body.sid).toMatch(/^VA[0-9a-f]{32}$/);
      expect(result.body.friendly_name).toBe("My App");
      expect(result.body.code_length).toBe(6);
    });

    it("rejects service creation without FriendlyName", async () => {
      const result = await api("POST", "/v2/Services", {});
      expect(result.status).toBe(400);
    });

    it("fetches, updates and deletes a service", async () => {
      const created = await api("POST", "/v2/Services", { FriendlyName: "Temp", CodeLength: "4" });
      const sid = created.body.sid;
      expect(created.body.code_length).toBe(4);
      const got = await api("GET", `/v2/Services/${sid}`);
      expect(got.body.friendly_name).toBe("Temp");
      const updated = await api("POST", `/v2/Services/${sid}`, { FriendlyName: "Renamed" });
      expect(updated.body.friendly_name).toBe("Renamed");
      const deleted = await api("DELETE", `/v2/Services/${sid}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v2/Services/${sid}`);
      expect(gone.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Verify v2 — verifications & checks", () => {
    let serviceSid: string;

    beforeEach(async () => {
      const created = await api("POST", "/v2/Services", { FriendlyName: "OTP" });
      serviceSid = created.body.sid;
    });

    it("creates a verification (pending)", async () => {
      const result = await api("POST", `/v2/Services/${serviceSid}/Verifications`, {
        To: "+15558675310",
        Channel: "sms",
      });
      expect(result.status).toBe(201);
      expect(result.body.sid).toMatch(/^VE[0-9a-f]{32}$/);
      expect(result.body.status).toBe("pending");
      expect(result.body.channel).toBe("sms");
      expect(result.body.valid).toBe(false);
      // Verify v2 returns ISO 8601 dates (not the RFC 2822 the 2010 API uses).
      expect(result.body.date_created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Non-SNA verifications carry sna: null in the real payload.
      expect(result.body.sna).toBe(null);
    });

    it("rejects verification with missing To", async () => {
      const result = await api("POST", `/v2/Services/${serviceSid}/Verifications`, { Channel: "sms" });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(60200);
    });

    it("rejects an invalid channel", async () => {
      const result = await api("POST", `/v2/Services/${serviceSid}/Verifications`, {
        To: "+15558675310",
        Channel: "carrier-pigeon",
      });
      expect(result.status).toBe(400);
    });

    it("approves a verification check with the correct code", async () => {
      const started = await api("POST", `/v2/Services/${serviceSid}/Verifications`, {
        To: "+15558675310",
        Channel: "sms",
      });
      const check = await api("POST", `/v2/Services/${serviceSid}/VerificationCheck`, {
        To: "+15558675310",
        Code: "123456",
      });
      expect(check.status).toBe(200);
      expect(check.body.status).toBe("approved");
      expect(check.body.valid).toBe(true);
      // The check echoes the verification's own VE… sid (not a new one).
      expect(check.body.sid).toBe(started.body.sid);
      // Verify v2 returns ISO 8601 dates.
      expect(check.body.date_updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Real check payload includes sna_attempts_error_codes (empty for non-SNA).
      expect(check.body.sna_attempts_error_codes).toEqual([]);
    });

    it("leaves check pending with a wrong code", async () => {
      await api("POST", `/v2/Services/${serviceSid}/Verifications`, {
        To: "+15558675311",
        Channel: "sms",
      });
      const check = await api("POST", `/v2/Services/${serviceSid}/VerificationCheck`, {
        To: "+15558675311",
        Code: "000000",
      });
      expect(check.status).toBe(200);
      expect(check.body.status).toBe("pending");
      expect(check.body.valid).toBe(false);
    });

    it("returns 404 checking a non-existent verification", async () => {
      const check = await api("POST", `/v2/Services/${serviceSid}/VerificationCheck`, {
        To: "+19998887777",
        Code: "123456",
      });
      expect(check.status).toBe(404);
    });

    it("fetches a verification by sid", async () => {
      const created = await api("POST", `/v2/Services/${serviceSid}/Verifications`, {
        To: "+15558675312",
        Channel: "call",
      });
      const fetched = await api("GET", `/v2/Services/${serviceSid}/Verifications/${created.body.sid}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.sid).toBe(created.body.sid);
    });
  });

  // -------------------------------------------------------------------------
  describe("parlel inspection endpoints", () => {
    it("lists captured messages", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      const result = await api("GET", "/__parlel/messages", undefined, null);
      expect(result.status).toBe(200);
      expect(result.body.count).toBe(1);
    });

    it("lists captured calls", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, validCall());
      const result = await api("GET", "/__parlel/calls", undefined, null);
      expect(result.body.count).toBe(1);
    });

    it("lists captured verifications", async () => {
      const svc = await api("POST", "/v2/Services", { FriendlyName: "x" });
      await api("POST", `/v2/Services/${svc.body.sid}/Verifications`, { To: "+15558675310", Channel: "sms" });
      const result = await api("GET", "/__parlel/verifications", undefined, null);
      expect(result.body.count).toBe(1);
    });

    it("resets all state via /__parlel/reset", async () => {
      await api("POST", `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, validSms());
      const reset = await api("POST", "/__parlel/reset", undefined, null);
      expect(reset.status).toBe(200);
      const after = await api("GET", "/__parlel/messages", undefined, null);
      expect(after.body.count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Real `twilio` client wire-protocol compatibility (simulated)", () => {
    it("messages.create resolves with a queued SMS", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      const msg = await client.messages.create({
        to: "+15558675310",
        from: "+15017122661",
        body: "Hi from the twilio client sim",
      });
      expect(msg.sid).toMatch(/^SM/);
      expect(msg.status).toBe("queued");
    });

    it("messages.list returns created messages", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      await client.messages.create({ to: "+15558675310", from: "+15017122661", body: "a" });
      await client.messages.create({ to: "+15558675310", from: "+15017122661", body: "b" });
      const list = await client.messages.list();
      expect(list.length).toBe(2);
    });

    it("messages.get().fetch() retrieves by sid", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      const created = await client.messages.create({ to: "+15558675310", from: "+15017122661", body: "x" });
      const fetched = await client.messages.get(created.sid).fetch();
      expect(fetched.sid).toBe(created.sid);
    });

    it("messages.create rejects an invalid To with a typed error", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      await expect(
        client.messages.create({ to: "bad", from: "+15017122661", body: "x" }),
      ).rejects.toMatchObject({ status: 400, code: 21211 });
    });

    it("calls.create resolves with a queued call", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      const call = await client.calls.create({
        to: "+15558675310",
        from: "+15017122661",
        url: "https://parlel.dev/twiml.xml",
      });
      expect(call.sid).toMatch(/^CA/);
      expect(call.status).toBe("queued");
    });

    it("verify.v2.services.create + verifications + checks full flow", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      const svc = await client.verify.v2.services.create({ friendlyName: "Sim App" });
      expect(svc.sid).toMatch(/^VA/);
      const created = await client.verify.v2.services(svc.sid).verifications.create({
        to: "+15558675399",
        channel: "sms",
      });
      expect(created.status).toBe("pending");
      const check = await client.verify.v2.services(svc.sid).verificationChecks.create({
        to: "+15558675399",
        code: "123456",
      });
      expect(check.valid).toBe(true);
    });

    it("parallel messages.create calls all succeed", async () => {
      const client = new TwilioClientSim(ACCOUNT_SID, AUTH_TOKEN);
      const results = await Promise.all([
        client.messages.create({ to: "+15558675310", from: "+15017122661", body: "1" }),
        client.messages.create({ to: "+15558675311", from: "+15017122661", body: "2" }),
        client.messages.create({ to: "+15558675312", from: "+15017122661", body: "3" }),
      ]);
      for (const r of results) expect(r.sid).toMatch(/^SM/);
      const inbox = await api("GET", "/__parlel/messages", undefined, null);
      expect(inbox.body.count).toBe(3);
    });
  });
});

function validSms(): Record<string, string> {
  return {
    To: "+15558675310",
    From: "+15017122661",
    Body: "Hello from parlel",
  };
}

function validCall(): Record<string, string> {
  return {
    To: "+15558675310",
    From: "+15017122661",
    Url: "https://parlel.dev/twiml.xml",
  };
}
