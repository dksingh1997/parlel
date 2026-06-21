import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/twilio — a tiny, dependency-free fake of the Twilio REST API.
//
// It speaks the exact wire protocol used by the official `twilio` Node client:
//   * HTTP Basic auth (AccountSid : AuthToken)
//   * application/x-www-form-urlencoded request bodies
//   * JSON responses
//   * the /2010-04-01/Accounts/{Sid}/... resource tree (Messages, Calls)
//   * the Verify v2 surface (/v2/Services, Verifications, VerificationChecks)
//
// State is in-memory and ephemeral; everything created is captured for
// inspection and assertions, and can be reset. Zero cost, zero side effects.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_BODY = Symbol("bad-body");

const E164_RE = /^\+[1-9]\d{1,14}$/;

function nowIso() {
  // The 2010-04-01 REST API (Messages, Calls, Accounts) returns RFC 2822
  // dates, e.g. "Fri, 24 May 2019 17:44:46 +0000".
  return new Date().toUTCString().replace("GMT", "+0000");
}

function nowIso8601() {
  // The Verify v2 product API (verify.twilio.com) returns ISO 8601 dates,
  // e.g. "2015-07-30T20:00:00Z" — a different format from the 2010 API.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hex(n) {
  return randomBytes(n).toString("hex").slice(0, n * 2);
}

// Twilio SIDs are a 2-char prefix + 32 hex chars.
function makeSid(prefix) {
  return `${prefix}${hex(16)}`;
}

// Twilio REST API error envelope.
function twerror(status, message, code, moreInfo) {
  return {
    code: code,
    message: message,
    more_info: moreInfo || `https://www.twilio.com/docs/errors/${code}`,
    status: status,
  };
}

export class TwilioServer {
  constructor(port = 4652, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    // The account this fake answers for. Any AC-prefixed SID is accepted as
    // the auth username, but this one is the "primary" returned by /Accounts.
    this.accountSid = options.accountSid || "ACparlel00000000000000000000000000";
    this.authToken = options.authToken || "parlel_test_auth_token";
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = new Map(); // sid -> message resource
    this.calls = new Map(); // sid -> call resource
    this.verifyServices = new Map(); // sid -> service resource
    this.verifications = new Map(); // sid -> verification resource
    // Track latest verification per (serviceSid, to) so a check can find it.
    this.verificationByTarget = new Map(); // `${serviceSid}|${to}` -> sid
    this._seedDefaults();
  }

  _seedDefaults() {
    // A default Verify service so list endpoints return something usable.
    const sid = makeSid("VA");
    this.verifyServices.set(sid, {
      sid,
      account_sid: this.accountSid,
      friendly_name: "parlel-default",
      code_length: 6,
      date_created: nowIso8601(),
      date_updated: nowIso8601(),
      url: this._absUrl(`/v2/Services/${sid}`),
    });
    this._defaultVerifyServiceSid = sid;
    // Stable default Messaging Service SID. The real API auto-assigns an
    // MG… value to every message even when one is not supplied.
    this._defaultMessagingServiceSid = makeSid("MG");
  }

  _absUrl(path) {
    return `http://${this.host}:${this.port}${path}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, twerror(500, error.message || "Internal server error", 20500));
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
    const query = url.searchParams;
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_BODY) return; // response already sent

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-twilio");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Unauthenticated infra endpoints.
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    // parlel control / inspection (not part of Twilio).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Everything else requires Basic auth.
    if (!this.isAuthorized(req)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Twilio API"');
      return this.send(res, 401, twerror(401, "Authentication Error - No credentials provided", 20003));
    }

    // -- Verify v2 surface: /v2/Services/...
    if (parts[0] === "v2") {
      return this.handleVerify(req, res, parts.slice(1), body, query);
    }

    // -- Classic REST API: /2010-04-01/Accounts/{Sid}/...
    if (parts[0] === "2010-04-01") {
      return this.handleApi2010(req, res, parts.slice(1), body, query);
    }

    return this.send(res, 404, twerror(404, "The requested resource was not found", 20404));
  }

  // -------------------------------------------------------------------------
  // /2010-04-01/Accounts/...
  // -------------------------------------------------------------------------
  handleApi2010(req, res, route, body, query) {
    // route[0] should be "Accounts" (it carries .json on the list endpoint).
    if (stripJson(route[0]) !== "Accounts") {
      return this.send(res, 404, twerror(404, "The requested resource was not found", 20404));
    }

    // GET /2010-04-01/Accounts.json — list accounts.
    if (route.length === 1 && req.method === "GET") {
      const acct = this.accountResource();
      return this.send(res, 200, this.listEnvelope("accounts", [acct], "/2010-04-01/Accounts.json"));
    }

    const accountSid = stripJson(route[1]);
    if (!accountSid) {
      return this.send(res, 404, twerror(404, "The requested resource was not found", 20404));
    }

    // GET /2010-04-01/Accounts/{Sid}.json — fetch account.
    if (route.length === 2) {
      if (route[1].endsWith(".json") && req.method === "GET") {
        return this.send(res, 200, this.accountResource(accountSid));
      }
      // /2010-04-01/Accounts/{Sid} with no resource
      return this.send(res, 404, twError404(this));
    }

    // route[2] is the sub-collection name. For collections it carries the
    // .json suffix (Messages.json); for item paths it does not (Messages).
    const resource = stripJson(route[2]);

    if (resource === "Messages") {
      return this.handleMessages(req, res, route, body, query, accountSid);
    }
    if (resource === "Calls") {
      return this.handleCalls(req, res, route, body, query, accountSid);
    }

    return this.send(res, 404, twError404(this));
  }

  // -------------------------------------------------------------------------
  // Messages: /2010-04-01/Accounts/{Sid}/Messages(.json) and /{MessageSid}.json
  // -------------------------------------------------------------------------
  handleMessages(req, res, route, body, query, accountSid) {
    // Collection: route length 3 (Accounts/{Sid}/Messages.json)
    if (route.length === 3) {
      if (req.method === "POST") return this.createMessage(res, body, accountSid);
      if (req.method === "GET") return this.listMessages(res, query, accountSid);
      return this.send(res, 405, twError405(this));
    }

    // Item: route length 4 (Accounts/{Sid}/Messages/{MessageSid}.json)
    const messageSid = stripJson(route[3]);
    if (route.length === 4) {
      const msg = this.messages.get(messageSid);
      if (req.method === "GET") {
        if (!msg) return this.send(res, 404, twError404(this));
        return this.send(res, 200, clone(msg));
      }
      if (req.method === "POST") {
        // Redact / update message (e.g. set Body to "").
        if (!msg) return this.send(res, 404, twError404(this));
        if (typeof body.Body === "string") msg.body = body.Body;
        if (typeof body.Status === "string") msg.status = body.Status;
        msg.date_updated = nowIso();
        return this.send(res, 200, clone(msg));
      }
      if (req.method === "DELETE") {
        if (!msg) return this.send(res, 404, twError404(this));
        this.messages.delete(messageSid);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, twError405(this));
    }

    return this.send(res, 404, twError404(this));
  }

  createMessage(res, body, accountSid) {
    const to = body.To;
    const from = body.From;
    const messagingServiceSid = body.MessagingServiceSid;
    const body_ = body.Body;
    const mediaUrl = body.MediaUrl;

    if (!to || typeof to !== "string") {
      return this.send(res, 400, twerror(400, "The 'To' number is required.", 21604));
    }
    if (!from && !messagingServiceSid) {
      return this.send(
        res,
        400,
        twerror(400, "A 'From' phone number or 'MessagingServiceSid' is required.", 21603)
      );
    }
    if (from && !E164_RE.test(from)) {
      return this.send(
        res,
        400,
        twerror(400, `The 'From' number ${from} is not a valid phone number.`, 21212)
      );
    }
    if (!E164_RE.test(to) && !to.startsWith("whatsapp:")) {
      return this.send(
        res,
        400,
        twerror(400, `The 'To' number ${to} is not a valid phone number.`, 21211)
      );
    }
    if ((body_ === undefined || body_ === "") && mediaUrl === undefined) {
      return this.send(
        res,
        400,
        twerror(400, "Message body is required.", 21602)
      );
    }

    const sid = makeSid("SM");
    const numSegments = body_ ? String(Math.max(1, Math.ceil(String(body_).length / 160))) : "1";
    const numMedia = mediaUrl ? (Array.isArray(mediaUrl) ? String(mediaUrl.length) : "1") : "0";

    const resource = {
      sid,
      account_sid: accountSid,
      api_version: "2010-04-01",
      body: body_ !== undefined ? String(body_) : "",
      num_segments: numSegments,
      num_media: numMedia,
      direction: "outbound-api",
      from: from || null,
      to,
      date_created: nowIso(),
      date_updated: nowIso(),
      date_sent: null,
      // The real API assigns a default MG… Messaging Service SID to every
      // message even when the caller does not supply one.
      messaging_service_sid: messagingServiceSid || this._defaultMessagingServiceSid,
      status: "queued",
      error_code: null,
      error_message: null,
      price: null,
      // price_unit is null until the message is billed (matches the real API,
      // which only populates currency once a price exists).
      price_unit: null,
      uri: `/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
      subresource_uris: {
        media: `/2010-04-01/Accounts/${accountSid}/Messages/${sid}/Media.json`,
      },
    };
    this.messages.set(sid, resource);
    return this.send(res, 201, clone(resource));
  }

  listMessages(res, query, accountSid) {
    let items = Array.from(this.messages.values());
    const to = query.get("To");
    const from = query.get("From");
    if (to) items = items.filter((m) => m.to === to);
    if (from) items = items.filter((m) => m.from === from);
    const pageSize = Number(query.get("PageSize") || 50);
    const page = items.slice(0, pageSize).map(clone);
    return this.send(
      res,
      200,
      this.listEnvelope("messages", page, `/2010-04-01/Accounts/${accountSid}/Messages.json`)
    );
  }

  // -------------------------------------------------------------------------
  // Calls: /2010-04-01/Accounts/{Sid}/Calls(.json) and /{CallSid}.json
  // -------------------------------------------------------------------------
  handleCalls(req, res, route, body, query, accountSid) {
    if (route.length === 3) {
      if (req.method === "POST") return this.createCall(res, body, accountSid);
      if (req.method === "GET") return this.listCalls(res, query, accountSid);
      return this.send(res, 405, twError405(this));
    }

    const callSid = stripJson(route[3]);
    if (route.length === 4) {
      const call = this.calls.get(callSid);
      if (req.method === "GET") {
        if (!call) return this.send(res, 404, twError404(this));
        return this.send(res, 200, clone(call));
      }
      if (req.method === "POST") {
        // Update / modify a call (e.g. Status=completed to hang up).
        if (!call) return this.send(res, 404, twError404(this));
        if (typeof body.Status === "string") call.status = body.Status;
        if (typeof body.Url === "string") call.url = body.Url;
        call.date_updated = nowIso();
        return this.send(res, 200, clone(call));
      }
      if (req.method === "DELETE") {
        if (!call) return this.send(res, 404, twError404(this));
        this.calls.delete(callSid);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, twError405(this));
    }

    return this.send(res, 404, twError404(this));
  }

  createCall(res, body, accountSid) {
    const to = body.To;
    const from = body.From;

    if (!to || typeof to !== "string") {
      return this.send(res, 400, twerror(400, "The 'To' number is required.", 21604));
    }
    if (!from || typeof from !== "string") {
      return this.send(res, 400, twerror(400, "A 'From' phone number is required.", 21603));
    }
    if (!E164_RE.test(from)) {
      return this.send(res, 400, twerror(400, `The 'From' number ${from} is not a valid phone number.`, 21212));
    }
    if (!E164_RE.test(to) && !to.startsWith("sip:") && !to.startsWith("client:")) {
      return this.send(res, 400, twerror(400, `The 'To' number ${to} is not a valid phone number.`, 21211));
    }
    if (!body.Url && !body.Twiml && !body.ApplicationSid) {
      return this.send(
        res,
        400,
        twerror(400, "Either Url, Twiml, or ApplicationSid parameter is required.", 21205)
      );
    }

    const sid = makeSid("CA");
    const resource = {
      sid,
      account_sid: accountSid,
      api_version: "2010-04-01",
      to,
      from,
      from_formatted: from,
      to_formatted: to,
      status: "queued",
      direction: "outbound-api",
      date_created: nowIso(),
      date_updated: nowIso(),
      start_time: null,
      end_time: null,
      duration: null,
      price: null,
      // price_unit is null until the call is billed (matches the real API).
      price_unit: null,
      answered_by: null,
      forwarded_from: null,
      caller_name: null,
      uri: `/2010-04-01/Accounts/${accountSid}/Calls/${sid}.json`,
      subresource_uris: {
        notifications: `/2010-04-01/Accounts/${accountSid}/Calls/${sid}/Notifications.json`,
        recordings: `/2010-04-01/Accounts/${accountSid}/Calls/${sid}/Recordings.json`,
        events: `/2010-04-01/Accounts/${accountSid}/Calls/${sid}/Events.json`,
      },
    };
    this.calls.set(sid, resource);
    return this.send(res, 201, clone(resource));
  }

  listCalls(res, query, accountSid) {
    let items = Array.from(this.calls.values());
    const to = query.get("To");
    const from = query.get("From");
    const status = query.get("Status");
    if (to) items = items.filter((c) => c.to === to);
    if (from) items = items.filter((c) => c.from === from);
    if (status) items = items.filter((c) => c.status === status);
    const pageSize = Number(query.get("PageSize") || 50);
    const page = items.slice(0, pageSize).map(clone);
    return this.send(
      res,
      200,
      this.listEnvelope("calls", page, `/2010-04-01/Accounts/${accountSid}/Calls.json`)
    );
  }

  // -------------------------------------------------------------------------
  // Account resource
  // -------------------------------------------------------------------------
  accountResource(sid) {
    const accountSid = sid || this.accountSid;
    return {
      sid: accountSid,
      friendly_name: "parlel-test-account",
      status: "active",
      type: "Full",
      auth_token: this.authToken,
      owner_account_sid: accountSid,
      date_created: nowIso(),
      date_updated: nowIso(),
      uri: `/2010-04-01/Accounts/${accountSid}.json`,
      subresource_uris: {
        messages: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        calls: `/2010-04-01/Accounts/${accountSid}/Calls.json`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Verify v2: /v2/Services, Verifications, VerificationCheck
  // -------------------------------------------------------------------------
  handleVerify(req, res, route, body, query) {
    if (route[0] !== "Services") {
      return this.send(res, 404, twError404(this));
    }

    // Collection: /v2/Services
    if (route.length === 1) {
      if (req.method === "POST") return this.createVerifyService(res, body);
      if (req.method === "GET") {
        const items = Array.from(this.verifyServices.values()).map(clone);
        return this.send(res, 200, this.listEnvelope("services", items, "/v2/Services"));
      }
      return this.send(res, 405, twError405(this));
    }

    const serviceSid = route[1];

    // Item: /v2/Services/{Sid}
    if (route.length === 2) {
      const svc = this.verifyServices.get(serviceSid);
      if (req.method === "GET") {
        if (!svc) return this.send(res, 404, twError404(this));
        return this.send(res, 200, clone(svc));
      }
      if (req.method === "POST") {
        if (!svc) return this.send(res, 404, twError404(this));
        if (typeof body.FriendlyName === "string") svc.friendly_name = body.FriendlyName;
        if (body.CodeLength !== undefined) svc.code_length = Number(body.CodeLength);
        svc.date_updated = nowIso8601();
        return this.send(res, 200, clone(svc));
      }
      if (req.method === "DELETE") {
        if (!svc) return this.send(res, 404, twError404(this));
        this.verifyServices.delete(serviceSid);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, twError405(this));
    }

    // Sub-resources of a service.
    const sub = route[2];
    const svc = this.verifyServices.get(serviceSid);
    if (!svc) return this.send(res, 404, twError404(this));

    // POST /v2/Services/{Sid}/Verifications
    if (sub === "Verifications") {
      if (route.length === 3 && req.method === "POST") {
        return this.createVerification(res, body, svc);
      }
      // GET /v2/Services/{Sid}/Verifications/{Sid}  (fetch by sid or 'to')
      if (route.length === 4) {
        const key = route[3];
        const verification =
          this.verifications.get(key) ||
          this.verifications.get(this.verificationByTarget.get(`${serviceSid}|${key}`));
        if (req.method === "GET") {
          if (!verification) return this.send(res, 404, twError404(this));
          return this.send(res, 200, clone(verification));
        }
        if (req.method === "POST") {
          if (!verification) return this.send(res, 404, twError404(this));
          if (typeof body.Status === "string") verification.status = body.Status;
          return this.send(res, 200, clone(verification));
        }
        return this.send(res, 405, twError405(this));
      }
    }

    // POST /v2/Services/{Sid}/VerificationCheck
    if (sub === "VerificationCheck" && route.length === 3 && req.method === "POST") {
      return this.checkVerification(res, body, svc);
    }

    return this.send(res, 404, twError404(this));
  }

  createVerifyService(res, body) {
    if (!body.FriendlyName || typeof body.FriendlyName !== "string") {
      return this.send(res, 400, twerror(400, "Required parameter FriendlyName missing.", 20001));
    }
    const sid = makeSid("VA");
    const svc = {
      sid,
      account_sid: this.accountSid,
      friendly_name: body.FriendlyName,
      code_length: body.CodeLength !== undefined ? Number(body.CodeLength) : 6,
      date_created: nowIso8601(),
      date_updated: nowIso8601(),
      url: this._absUrl(`/v2/Services/${sid}`),
    };
    this.verifyServices.set(sid, svc);
    return this.send(res, 201, clone(svc));
  }

  createVerification(res, body, svc) {
    const to = body.To;
    const channel = body.Channel;
    if (!to || typeof to !== "string") {
      return this.send(res, 400, twerror(400, "Required parameter To missing.", 60200));
    }
    if (!channel || typeof channel !== "string") {
      return this.send(res, 400, twerror(400, "Required parameter Channel missing.", 60200));
    }
    const validChannels = ["sms", "call", "email", "whatsapp", "sna"];
    if (!validChannels.includes(channel)) {
      return this.send(res, 400, twerror(400, `Invalid Channel: ${channel}`, 60200));
    }
    const sid = makeSid("VE");
    // Deterministic test code so VerificationCheck can succeed without OTP UX.
    const code = "123456".slice(0, svc.code_length || 6).padEnd(svc.code_length || 6, "0");
    const verification = {
      sid,
      service_sid: svc.sid,
      account_sid: this.accountSid,
      to,
      channel,
      status: "pending",
      valid: false,
      date_created: nowIso8601(),
      date_updated: nowIso8601(),
      lookup: {},
      amount: null,
      payee: null,
      send_code_attempts: [{ time: nowIso8601(), channel, attempt_sid: makeSid("VL") }],
      // Non-SNA channels return sna: null. The real payload always carries the
      // field (it holds the SNA challenge URL only for the sna channel).
      sna: null,
      url: this._absUrl(`/v2/Services/${svc.sid}/Verifications/${sid}`),
      // Not part of the real payload, but exposed so test harnesses can read
      // the OTP that would normally arrive out-of-band.
      _parlel_code: code,
    };
    this.verifications.set(sid, verification);
    this.verificationByTarget.set(`${svc.sid}|${to}`, sid);
    return this.send(res, 201, clone(verification));
  }

  checkVerification(res, body, svc) {
    const code = body.Code;
    const to = body.To;
    const verificationSid = body.VerificationSid;
    if (!code || typeof code !== "string") {
      return this.send(res, 400, twerror(400, "Required parameter Code missing.", 60200));
    }
    if (!to && !verificationSid) {
      return this.send(res, 400, twerror(400, "Required parameter To or VerificationSid missing.", 60200));
    }

    let verification = null;
    if (verificationSid) {
      verification = this.verifications.get(verificationSid);
    } else {
      const sid = this.verificationByTarget.get(`${svc.sid}|${to}`);
      verification = sid ? this.verifications.get(sid) : null;
    }

    if (!verification) {
      // Twilio returns 404 with code 20404 when there is no pending verification.
      return this.send(res, 404, twerror(404, "The requested resource was not found", 20404));
    }

    const expected = verification._parlel_code;
    const approved = code === expected || code === "123456";
    if (approved) {
      verification.status = "approved";
      verification.valid = true;
      verification.date_updated = nowIso8601();
    }

    const result = {
      // The real VerificationCheck response echoes the verification's own
      // VE… sid, not a freshly minted one.
      sid: verification.sid,
      service_sid: svc.sid,
      account_sid: this.accountSid,
      to: verification.to,
      channel: verification.channel,
      status: approved ? "approved" : "pending",
      valid: approved,
      amount: null,
      payee: null,
      // Empty list for non-SNA channels (null only when the last channel was sna).
      sna_attempts_error_codes: [],
      date_created: verification.date_created,
      date_updated: nowIso8601(),
    };
    return this.send(res, 200, result);
  }

  // -------------------------------------------------------------------------
  // List envelope (Twilio paging shape).
  // -------------------------------------------------------------------------
  listEnvelope(key, items, baseUri) {
    return {
      [key]: items,
      first_page_uri: `${baseUri}?PageSize=50&Page=0`,
      next_page_uri: null,
      previous_page_uri: null,
      uri: `${baseUri}?PageSize=50&Page=0`,
      page: 0,
      page_size: 50,
      start: 0,
      end: Math.max(0, items.length - 1),
    };
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of Twilio).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, _body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 2) {
      const messages = Array.from(this.messages.values()).map(clone);
      return this.send(res, 200, { messages, count: messages.length });
    }
    if (req.method === "GET" && parts[1] === "calls" && parts.length === 2) {
      const calls = Array.from(this.calls.values()).map(clone);
      return this.send(res, 200, { calls, count: calls.length });
    }
    if (req.method === "GET" && parts[1] === "verifications" && parts.length === 2) {
      const verifications = Array.from(this.verifications.values()).map(clone);
      return this.send(res, 200, { verifications, count: verifications.length });
    }
    return this.send(res, 404, twError404(this));
  }

  root() {
    return {
      name: "twilio",
      version: "1.0",
      protocol: "twilio-rest",
      documentation: "/docs/twilio.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    const match = /^Basic\s+(\S+)/i.exec(auth);
    if (!match) return false;
    let decoded = "";
    try {
      decoded = Buffer.from(match[1], "base64").toString("utf8");
    } catch {
      return false;
    }
    const idx = decoded.indexOf(":");
    if (idx === -1) return false;
    const user = decoded.slice(0, idx);
    // Accept any AC-prefixed account sid (or an API key SK...) as the username.
    return /^AC[0-9a-zA-Z]+$/.test(user) || /^SK[0-9a-zA-Z]+$/.test(user);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        const contentType = (req.headers["content-type"] || "").toLowerCase();
        try {
          if (contentType.includes("application/json")) {
            resolve(JSON.parse(data));
          } else {
            // Default Twilio content type: application/x-www-form-urlencoded.
            resolve(parseForm(data));
          }
        } catch {
          this.send(res, 400, twerror(400, "Bad request body", 20001));
          resolve(SENTINEL_BAD_BODY);
        }
      });
      req.on("error", () => {
        this.send(res, 400, twerror(400, "Bad request body", 20001));
        resolve(SENTINEL_BAD_BODY);
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stripJson(segment) {
  if (typeof segment !== "string") return segment;
  return segment.endsWith(".json") ? segment.slice(0, -5) : segment;
}

// Parse application/x-www-form-urlencoded into a plain object. Repeated keys
// (e.g. MediaUrl) become arrays, mirroring the real Twilio API.
function parseForm(data) {
  const params = new URLSearchParams(data);
  const out = {};
  for (const [key, value] of params.entries()) {
    if (key in out) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function twError404() {
  return twerror(404, "The requested resource was not found", 20404);
}

function twError405() {
  return twerror(405, "Method not allowed", 20004);
}
