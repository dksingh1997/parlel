import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WhatsappServer } from "../services/whatsapp/src/server.js";

const PORT = 14657;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ACCESS_TOKEN = "parlel-test-access-token";
const PHONE_NUMBER_ID = "100000000000001";
const WABA_ID = "200000000000001";
const API_VERSION = "v21.0";
const VERIFY_TOKEN = "parlel-verify-token";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  text: string;
  headers: Headers;
}

/**
 * Generic helper that mirrors how an `axios` integration talks to the
 * WhatsApp Cloud API (Meta Graph API): Bearer-token auth, JSON request
 * bodies, JSON responses.
 */
async function api(
  method: string,
  path: string,
  json?: Json,
  auth: string | null = ACCESS_TOKEN,
): Promise<ApiResult> {
  const headers: Json = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  let body: string | undefined;
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

/**
 * Faithful, dependency-free re-implementation of how an `axios`-based
 * WhatsApp Cloud API client dispatches requests. The real integration:
 *   - sets `axios` baseURL = `https://graph.facebook.com/<version>`
 *   - sends `Authorization: Bearer <token>` on every request
 *   - POSTs JSON to `/<PHONE_NUMBER_ID>/messages`
 *   - throws on non-2xx, surfacing `error.response.data.error`
 * This mirror exercises the exact protocol with zero external deps.
 */
class WhatsAppCloudClient {
  constructor(
    private opts: {
      token: string;
      phoneNumberId: string;
      businessAccountId: string;
      version: string;
      baseUrl?: string;
    },
  ) {}

  private get baseUrl() {
    return `${this.opts.baseUrl || BASE_URL}/${this.opts.version}`;
  }

  // Generic request matching axios semantics (resolve 2xx, throw otherwise).
  private async request(method: string, path: string, data?: Json, params?: Json): Promise<Json> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers: Json = { Authorization: `Bearer ${this.opts.token}` };
    let body: string | undefined;
    if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(data);
    }
    const res = await fetch(url.toString(), { method, headers, body });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (res.status < 200 || res.status >= 300) {
      const err: any = new Error(parsed?.error?.message || res.statusText);
      err.response = { status: res.status, data: parsed };
      throw err;
    }
    return parsed;
  }

  sendText(to: string, text: string, extra: Json = {}) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text, ...(extra.preview_url !== undefined ? { preview_url: extra.preview_url } : {}) },
      ...(extra.context ? { context: extra.context } : {}),
    });
  }

  sendTemplate(to: string, name: string, language: string, components?: any[]) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name, language: { code: language }, ...(components ? { components } : {}) },
    });
  }

  sendImage(to: string, image: Json) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image,
    });
  }

  sendMedia(to: string, type: string, media: Json) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type,
      [type]: media,
    });
  }

  sendLocation(to: string, location: Json) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "location",
      location,
    });
  }

  sendContacts(to: string, contacts: any[]) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "contacts",
      contacts,
    });
  }

  sendInteractive(to: string, interactive: Json) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive,
    });
  }

  sendReaction(to: string, messageId: string, emoji: string) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "reaction",
      reaction: { message_id: messageId, emoji },
    });
  }

  markRead(messageId: string, typing?: string) {
    return this.request("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      ...(typing ? { typing_indicator: { type: typing } } : {}),
    });
  }

  getMedia(mediaId: string) {
    return this.request("GET", `/${mediaId}`);
  }

  deleteMedia(mediaId: string) {
    return this.request("DELETE", `/${mediaId}`);
  }

  getPhoneNumber(fields?: string) {
    return this.request("GET", `/${this.opts.phoneNumberId}`, undefined, fields ? { fields } : undefined);
  }

  listPhoneNumbers() {
    return this.request("GET", `/${this.opts.businessAccountId}/phone_numbers`);
  }

  getBusinessProfile(fields?: string) {
    return this.request(
      "GET",
      `/${this.opts.phoneNumberId}/whatsapp_business_profile`,
      undefined,
      fields ? { fields } : undefined,
    );
  }

  updateBusinessProfile(update: Json) {
    return this.request("POST", `/${this.opts.phoneNumberId}/whatsapp_business_profile`, {
      messaging_product: "whatsapp",
      ...update,
    });
  }

  listTemplates() {
    return this.request("GET", `/${this.opts.businessAccountId}/message_templates`);
  }

  createTemplate(tpl: Json) {
    return this.request("POST", `/${this.opts.businessAccountId}/message_templates`, tpl);
  }

  deleteTemplate(name: string) {
    return this.request("DELETE", `/${this.opts.businessAccountId}/message_templates`, undefined, { name });
  }

  registerNumber(pin: string) {
    return this.request("POST", `/${this.opts.phoneNumberId}/register`, { messaging_product: "whatsapp", pin });
  }

  deregisterNumber() {
    return this.request("POST", `/${this.opts.phoneNumberId}/deregister`, {});
  }

  requestCode(method: string) {
    return this.request("POST", `/${this.opts.phoneNumberId}/request_code`, { code_method: method, language: "en_US" });
  }

  verifyCode(code: string) {
    return this.request("POST", `/${this.opts.phoneNumberId}/verify_code`, { code });
  }
}

let server: WhatsappServer;
let client: WhatsAppCloudClient;

beforeAll(async () => {
  server = new WhatsappServer(PORT);
  await server.start();
  client = new WhatsAppCloudClient({
    token: ACCESS_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    businessAccountId: WABA_ID,
    version: API_VERSION,
  });
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  // Reset ephemeral state between tests.
  await api("POST", "/__parlel/reset");
});

// ---------------------------------------------------------------------------
// Infra / health
// ---------------------------------------------------------------------------
describe("infra", () => {
  it("responds to /health", async () => {
    const r = await api("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("root metadata describes the service", async () => {
    const r = await api("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("whatsapp");
    expect(r.body.protocol).toBe("whatsapp-cloud-api");
  });

  it("sets the facebook-api-version header", async () => {
    const r = await api("GET", "/health");
    expect(r.headers.get("facebook-api-version")).toBe(API_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("auth", () => {
  it("rejects requests without a bearer token", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: "15551230000",
      type: "text",
      text: { body: "hi" },
    }, null);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe(190);
  });

  it("rejects an invalid bearer token", async () => {
    const r = await api(
      "POST",
      `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: "15551230000", type: "text", text: { body: "hi" } },
      "wrong-token",
    );
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe("OAuthException");
  });

  it("accepts a valid bearer token", async () => {
    const res = await client.sendText("15551230000", "authorized");
    expect(res.messaging_product).toBe("whatsapp");
  });
});

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
describe("messages: send", () => {
  it("sends a text message and returns the Cloud API envelope", async () => {
    const res = await client.sendText("15551230000", "hello parlel");
    expect(res.messaging_product).toBe("whatsapp");
    expect(res.contacts[0].input).toBe("15551230000");
    expect(res.contacts[0].wa_id).toBe("15551230000");
    expect(res.messages[0].id).toMatch(/^wamid\./);
    expect(res.messages[0].message_status).toBe("accepted");
  });

  it("records sent messages for inspection", async () => {
    await client.sendText("15551230000", "first");
    await client.sendText("15551230001", "second");
    const r = await api("GET", "/__parlel/messages");
    expect(r.body.count).toBe(2);
    expect(r.body.messages[0].type).toBe("text");
    expect(r.body.messages[1].to).toBe("15551230001");
  });

  it("supports preview_url and reply context", async () => {
    const first = await client.sendText("15551230000", "original");
    const res = await client.sendText("15551230000", "reply", {
      preview_url: true,
      context: { message_id: first.messages[0].id },
    });
    expect(res.messages[0].id).toMatch(/^wamid\./);
    const r = await api("GET", "/__parlel/messages");
    const replyMsg = r.body.messages.find((m: Json) => m.context);
    expect(replyMsg.context.message_id).toBe(first.messages[0].id);
  });

  it("rejects a text message missing the body", async () => {
    let err: any;
    try {
      await client.sendMedia("15551230000", "text", {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response.status).toBe(400);
    expect(err.response.data.error.code).toBe(100);
  });

  it("rejects a message missing the recipient", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      type: "text",
      text: { body: "no recipient" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.error_data.details).toMatch(/to is required/);
  });

  it("rejects a missing messaging_product", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      to: "15551230000",
      type: "text",
      text: { body: "hi" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.error_data.messaging_product).toBe("whatsapp");
  });

  it("rejects an unsupported message type", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: "15551230000",
      type: "carrier_pigeon",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Invalid message type/);
  });
});

describe("messages: media types", () => {
  it("sends an image by link", async () => {
    const res = await client.sendImage("15551230000", { link: "https://parlel.test/cat.jpg", caption: "cat" });
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("sends an image by id", async () => {
    const res = await client.sendImage("15551230000", { id: "999000111" });
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("rejects an image with neither id nor link", async () => {
    let err: any;
    try {
      await client.sendImage("15551230000", { caption: "missing" });
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
    expect(err.response.data.error.error_data.details).toMatch(/id or .*link/);
  });

  it("sends audio, video, document, and sticker", async () => {
    const audio = await client.sendMedia("15551230000", "audio", { link: "https://parlel.test/a.mp3" });
    const video = await client.sendMedia("15551230000", "video", { link: "https://parlel.test/v.mp4" });
    const doc = await client.sendMedia("15551230000", "document", { link: "https://parlel.test/d.pdf", filename: "d.pdf" });
    const sticker = await client.sendMedia("15551230000", "sticker", { id: "555000111" });
    for (const r of [audio, video, doc, sticker]) {
      expect(r.messages[0].id).toMatch(/^wamid\./);
    }
    const list = await api("GET", "/__parlel/messages");
    expect(list.body.count).toBe(4);
  });
});

describe("messages: location, contacts, interactive, reaction", () => {
  it("sends a location", async () => {
    const res = await client.sendLocation("15551230000", {
      latitude: 37.42,
      longitude: -122.08,
      name: "Googleplex",
      address: "Mountain View",
    });
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("rejects a location missing coordinates", async () => {
    let err: any;
    try {
      await client.sendLocation("15551230000", { name: "nowhere" });
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
  });

  it("sends contacts", async () => {
    const res = await client.sendContacts("15551230000", [
      { name: { formatted_name: "Jane Doe", first_name: "Jane" }, phones: [{ phone: "+15551230002" }] },
    ]);
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("rejects an empty contacts array", async () => {
    let err: any;
    try {
      await client.sendContacts("15551230000", []);
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
  });

  it("sends an interactive button message", async () => {
    const res = await client.sendInteractive("15551230000", {
      type: "button",
      body: { text: "Pick one" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "yes", title: "Yes" } },
          { type: "reply", reply: { id: "no", title: "No" } },
        ],
      },
    });
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("rejects interactive without a type", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: "15551230000",
      type: "interactive",
      interactive: { body: { text: "x" } },
    });
    expect(r.status).toBe(400);
  });

  it("sends a reaction", async () => {
    const first = await client.sendText("15551230000", "react to me");
    const res = await client.sendReaction("15551230000", first.messages[0].id, "👍");
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("rejects a reaction without message_id", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: "15551230000",
      type: "reaction",
      reaction: { emoji: "👍" },
    });
    expect(r.status).toBe(400);
  });
});

describe("messages: templates", () => {
  it("sends an approved template", async () => {
    const res = await client.sendTemplate("15551230000", "hello_world", "en_US");
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("sends a template with components", async () => {
    const res = await client.sendTemplate("15551230000", "hello_world", "en_US", [
      { type: "body", parameters: [{ type: "text", text: "Parlel" }] },
    ]);
    expect(res.messages[0].id).toMatch(/^wamid\./);
  });

  it("rejects a non-existent template", async () => {
    let err: any;
    try {
      await client.sendTemplate("15551230000", "does_not_exist", "en_US");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(404);
    expect(err.response.data.error.code).toBe(132001);
  });

  it("rejects a template missing language", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: "15551230000",
      type: "template",
      template: { name: "hello_world" },
    });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Mark as read + typing
// ---------------------------------------------------------------------------
describe("messages: mark read and typing", () => {
  it("marks an inbound message as read", async () => {
    const res = await client.markRead("wamid.inbound123");
    expect(res.success).toBe(true);
    const r = await api("GET", "/__parlel/read-receipts");
    expect(r.body.count).toBe(1);
    expect(r.body.read_receipts[0].message_id).toBe("wamid.inbound123");
  });

  it("sends a typing indicator with the read receipt", async () => {
    await client.markRead("wamid.inbound456", "text");
    const r = await api("GET", "/__parlel/typing");
    expect(r.body.count).toBe(1);
    expect(r.body.typing[0].type).toBe("text");
  });

  it("rejects status=read without message_id", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
    });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Media: upload / retrieve / delete / download
// ---------------------------------------------------------------------------
describe("media", () => {
  async function upload(): Promise<string> {
    const boundary = "----parlelboundary";
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nimage/jpeg\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cat.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ];
    const head = Buffer.from(parts.join(""), "utf8");
    const fileData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, fileData, tail]);
    const res = await fetch(`${BASE_URL}/${API_VERSION}/${PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBeDefined();
    return json.id;
  }

  it("uploads media via multipart and returns an id", async () => {
    const id = await upload();
    expect(typeof id).toBe("string");
  });

  it("retrieves uploaded media metadata", async () => {
    const id = await upload();
    const meta = await client.getMedia(id);
    expect(meta.messaging_product).toBe("whatsapp");
    expect(meta.mime_type).toBe("image/jpeg");
    expect(meta.id).toBe(id);
    expect(meta.url).toContain("/__media/");
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads the media binary with the bearer token", async () => {
    const id = await upload();
    const meta = await client.getMedia(id);
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(8);
    expect(buf[0]).toBe(0xff);
  });

  it("rejects media download without auth", async () => {
    const id = await upload();
    const meta = await client.getMedia(id);
    const res = await fetch(meta.url);
    expect(res.status).toBe(401);
  });

  it("deletes media", async () => {
    const id = await upload();
    const del = await client.deleteMedia(id);
    expect(del.success).toBe(true);
    let err: any;
    try {
      await client.getMedia(id);
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(404);
  });

  it("returns 404 for unknown media id", async () => {
    let err: any;
    try {
      await client.getMedia("000000nonexistent");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(404);
    expect(err.response.data.error.code).toBe(100);
  });

  it("rejects upload without messaging_product", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/media`, { type: "image/jpeg" });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Phone number / WABA
// ---------------------------------------------------------------------------
describe("phone number & WABA", () => {
  it("fetches phone number info", async () => {
    const pn = await client.getPhoneNumber();
    expect(pn.id).toBe(PHONE_NUMBER_ID);
    expect(pn.display_phone_number).toBeDefined();
    expect(pn.quality_rating).toBe("GREEN");
  });

  it("fetches phone number info with field projection", async () => {
    const pn = await client.getPhoneNumber("verified_name,quality_rating");
    expect(pn.id).toBe(PHONE_NUMBER_ID);
    expect(pn.verified_name).toBeDefined();
    expect(pn.quality_rating).toBe("GREEN");
    expect(pn.display_phone_number).toBeUndefined();
  });

  it("lists phone numbers on the WABA", async () => {
    const res = await client.listPhoneNumbers();
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data[0].id).toBe(PHONE_NUMBER_ID);
    expect(res.paging.cursors).toBeDefined();
  });

  it("fetches WABA info", async () => {
    const r = await api("GET", `/${API_VERSION}/${WABA_ID}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(WABA_ID);
    expect(r.body.name).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------
describe("business profile", () => {
  it("gets the business profile", async () => {
    const res = await client.getBusinessProfile();
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data[0].messaging_product).toBe("whatsapp");
    expect(res.data[0].about).toBeDefined();
  });

  it("gets the business profile with field projection", async () => {
    const res = await client.getBusinessProfile("about,email");
    expect(res.data[0].about).toBeDefined();
    expect(res.data[0].email).toBeDefined();
    expect(res.data[0].address).toBeUndefined();
  });

  it("updates the business profile", async () => {
    const upd = await client.updateBusinessProfile({ about: "updated about", email: "new@parlel.test" });
    expect(upd.success).toBe(true);
    const res = await client.getBusinessProfile();
    expect(res.data[0].about).toBe("updated about");
    expect(res.data[0].email).toBe("new@parlel.test");
  });

  it("rejects a profile update missing messaging_product", async () => {
    const r = await api("POST", `/${API_VERSION}/${PHONE_NUMBER_ID}/whatsapp_business_profile`, {
      about: "no product",
    });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Message templates (management)
// ---------------------------------------------------------------------------
describe("message templates management", () => {
  it("lists templates (seeded hello_world)", async () => {
    const res = await client.listTemplates();
    expect(res.data.some((t: Json) => t.name === "hello_world")).toBe(true);
  });

  it("creates a template", async () => {
    const res = await client.createTemplate({
      name: "order_update",
      category: "UTILITY",
      language: "en_US",
      components: [{ type: "BODY", text: "Your order {{1}} shipped" }],
    });
    expect(res.id).toBeDefined();
    expect(res.status).toBe("PENDING");
    const list = await client.listTemplates();
    expect(list.data.some((t: Json) => t.name === "order_update")).toBe(true);
  });

  it("rejects a duplicate template name", async () => {
    await client.createTemplate({ name: "dup", category: "UTILITY", language: "en_US" });
    let err: any;
    try {
      await client.createTemplate({ name: "dup", category: "UTILITY", language: "en_US" });
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
  });

  it("rejects a template missing required fields", async () => {
    let err: any;
    try {
      await client.createTemplate({ name: "incomplete" });
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
  });

  it("deletes a template", async () => {
    await client.createTemplate({ name: "to_delete", category: "UTILITY", language: "en_US" });
    const del = await client.deleteTemplate("to_delete");
    expect(del.success).toBe(true);
    const list = await client.listTemplates();
    expect(list.data.some((t: Json) => t.name === "to_delete")).toBe(false);
  });

  it("returns 404 when deleting an unknown template", async () => {
    let err: any;
    try {
      await client.deleteTemplate("ghost");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Registration / verification
// ---------------------------------------------------------------------------
describe("registration & verification", () => {
  it("registers a number with a 6-digit pin", async () => {
    const res = await client.registerNumber("123456");
    expect(res.success).toBe(true);
  });

  it("rejects registration with a bad pin", async () => {
    let err: any;
    try {
      await client.registerNumber("12");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
  });

  it("deregisters a number", async () => {
    const res = await client.deregisterNumber();
    expect(res.success).toBe(true);
  });

  it("requests and verifies a code", async () => {
    const req = await client.requestCode("SMS");
    expect(req.success).toBe(true);
    const ver = await client.verifyCode("123456");
    expect(ver.success).toBe(true);
  });

  it("rejects verify_code before request_code", async () => {
    let err: any;
    try {
      await client.verifyCode("123456");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
    expect(err.response.data.error.code).toBe(136025);
  });

  it("rejects an incorrect verification code", async () => {
    await client.requestCode("SMS");
    let err: any;
    try {
      await client.verifyCode("000000");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
    expect(err.response.data.error.code).toBe(136024);
  });

  it("rejects request_code with an invalid method", async () => {
    let err: any;
    try {
      await client.requestCode("CARRIER_PIGEON");
    } catch (e) {
      err = e;
    }
    expect(err.response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------
describe("webhook verification", () => {
  it("echoes the challenge for a valid verify token", async () => {
    const res = await fetch(
      `${BASE_URL}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge123`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("challenge123");
  });

  it("rejects an invalid verify token", async () => {
    const res = await fetch(
      `${BASE_URL}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge123`,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Inbound webhook simulation (control plane)
// ---------------------------------------------------------------------------
describe("inbound webhook simulation", () => {
  it("builds an inbound message event", async () => {
    const r = await api("POST", "/__parlel/inbound", { from: "15559990000", text: "hi there", name: "Alice" });
    expect(r.status).toBe(200);
    const value = r.body.event.entry[0].changes[0].value;
    expect(value.messaging_product).toBe("whatsapp");
    expect(value.messages[0].text.body).toBe("hi there");
    expect(value.contacts[0].wa_id).toBe("15559990000");
  });

  it("builds a status callback event", async () => {
    const r = await api("POST", "/__parlel/status", { message_id: "wamid.x", status: "delivered" });
    expect(r.status).toBe(200);
    const value = r.body.event.entry[0].changes[0].value;
    expect(value.statuses[0].status).toBe("delivered");
  });

  it("lists queued inbound events", async () => {
    await api("POST", "/__parlel/inbound", { text: "one" });
    await api("POST", "/__parlel/status", { status: "read" });
    const r = await api("GET", "/__parlel/inbound");
    expect(r.body.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Reset / state management
// ---------------------------------------------------------------------------
describe("state reset", () => {
  it("clears sent messages on reset", async () => {
    await client.sendText("15551230000", "before reset");
    let r = await api("GET", "/__parlel/messages");
    expect(r.body.count).toBe(1);
    await api("POST", "/__parlel/reset");
    r = await api("GET", "/__parlel/messages");
    expect(r.body.count).toBe(0);
  });

  it("restores seeded templates after reset", async () => {
    await client.deleteTemplate("hello_world");
    await api("POST", "/__parlel/reset");
    const list = await client.listTemplates();
    expect(list.data.some((t: Json) => t.name === "hello_world")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown resources
// ---------------------------------------------------------------------------
describe("unknown resources", () => {
  it("returns a graph error for an unknown object id", async () => {
    const r = await api("GET", `/${API_VERSION}/999999unknown`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe(100);
  });
});
