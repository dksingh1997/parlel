import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConvertkitServer } from "../services/convertkit/src/server.js";

const PORT = 14667;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlel_test_public_api_key";
const API_SECRET = "parlel_test_secret_api_key";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  data: any;
  headers: Headers;
}

/**
 * Faithful re-implementation of how application code drives the ConvertKit
 * (Kit) v3 REST API with `axios`. The documented pattern is:
 *
 *   const ck = axios.create({
 *     baseURL: "https://api.convertkit.com/v3",
 *     headers: { "Content-Type": "application/json" },
 *   });
 *   // public endpoints authenticate with api_key, private with api_secret,
 *   // supplied either as a query param or a JSON body field.
 *   await ck.post(`/forms/${formId}/subscribe`, { api_key, email });
 *   await ck.get(`/subscribers`, { params: { api_secret } });
 *
 * This sim mirrors that exact request shape on the wire (plain JSON body,
 * api_key/api_secret auth), exercising the precise protocol the real axios
 * client speaks — with zero external dependencies.
 */
class ConvertKitAxiosSim {
  constructor(private apiKey: string, private apiSecret: string, private baseUrl = `${BASE_URL}/v3`) {}

  private async request(method: string, path: string, params?: Json, data?: Json): Promise<ApiResult> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const response = await fetch(url.toString(), {
      method,
      headers: data !== undefined ? { "Content-Type": "application/json" } : {},
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status: response.status, data: parsed, headers: response.headers };
  }

  // Account (api_secret)
  getAccount = () => this.request("GET", "/account", { api_secret: this.apiSecret });
  getCreatorProfile = () => this.request("GET", "/account/creator_profile", { api_secret: this.apiSecret });
  getGrowthStats = () => this.request("GET", "/account/growth_stats", { api_secret: this.apiSecret });

  // Forms
  listForms = () => this.request("GET", "/forms", { api_key: this.apiKey });
  subscribeToForm = (formId: number, body: Json) =>
    this.request("POST", `/forms/${formId}/subscribe`, undefined, { api_key: this.apiKey, ...body });
  listFormSubscriptions = (formId: number, params: Json = {}) =>
    this.request("GET", `/forms/${formId}/subscriptions`, { api_secret: this.apiSecret, ...params });

  // Sequences
  listSequences = () => this.request("GET", "/sequences", { api_key: this.apiKey });
  subscribeToSequence = (seqId: number, body: Json) =>
    this.request("POST", `/sequences/${seqId}/subscribe`, undefined, { api_key: this.apiKey, ...body });
  listSequenceSubscriptions = (seqId: number, params: Json = {}) =>
    this.request("GET", `/sequences/${seqId}/subscriptions`, { api_secret: this.apiSecret, ...params });

  // Tags
  listTags = () => this.request("GET", "/tags", { api_key: this.apiKey });
  createTag = (name: string | Json) => this.request("POST", "/tags", undefined, { api_secret: this.apiSecret, tag: name });
  createTagsBulk = (names: any[]) => this.request("POST", "/tags", undefined, { api_secret: this.apiSecret, tag: names });
  tagSubscribe = (tagId: number, body: Json) =>
    this.request("POST", `/tags/${tagId}/subscribe`, undefined, { api_key: this.apiKey, ...body });
  tagUnsubscribe = (tagId: number, email: string) =>
    this.request("POST", `/tags/${tagId}/unsubscribe`, undefined, { api_secret: this.apiSecret, email });
  listTagSubscriptions = (tagId: number, params: Json = {}) =>
    this.request("GET", `/tags/${tagId}/subscriptions`, { api_secret: this.apiSecret, ...params });

  // Subscribers
  listSubscribers = (params: Json = {}) => this.request("GET", "/subscribers", { api_secret: this.apiSecret, ...params });
  getSubscriber = (id: number) => this.request("GET", `/subscribers/${id}`, { api_secret: this.apiSecret });
  updateSubscriber = (id: number, body: Json) =>
    this.request("PUT", `/subscribers/${id}`, undefined, { api_secret: this.apiSecret, ...body });
  getSubscriberTags = (id: number) => this.request("GET", `/subscribers/${id}/tags`, { api_secret: this.apiSecret });
  unsubscribe = (email: string) => this.request("PUT", "/unsubscribe", undefined, { api_secret: this.apiSecret, email });

  // Custom fields
  listCustomFields = () => this.request("GET", "/custom_fields", { api_key: this.apiKey });
  createCustomField = (label: string) => this.request("POST", "/custom_fields", undefined, { api_secret: this.apiSecret, label });
  createCustomFieldsBulk = (labels: any[]) =>
    this.request("POST", "/custom_fields", undefined, { api_secret: this.apiSecret, custom_fields: labels });
  updateCustomField = (id: number, label: string) =>
    this.request("PUT", `/custom_fields/${id}`, undefined, { api_secret: this.apiSecret, label });
  deleteCustomField = (id: number) => this.request("DELETE", `/custom_fields/${id}`, { api_secret: this.apiSecret });

  // Broadcasts
  listBroadcasts = () => this.request("GET", "/broadcasts", { api_secret: this.apiSecret });
  createBroadcast = (body: Json) => this.request("POST", "/broadcasts", undefined, { api_secret: this.apiSecret, ...body });
  getBroadcast = (id: number) => this.request("GET", `/broadcasts/${id}`, { api_secret: this.apiSecret });
  updateBroadcast = (id: number, body: Json) =>
    this.request("PUT", `/broadcasts/${id}`, undefined, { api_secret: this.apiSecret, ...body });
  deleteBroadcast = (id: number) => this.request("DELETE", `/broadcasts/${id}`, { api_secret: this.apiSecret });
  getBroadcastStats = (id: number) => this.request("GET", `/broadcasts/${id}/stats`, { api_secret: this.apiSecret });

  // Webhooks
  createWebhook = (body: Json) => this.request("POST", "/automations/hooks", undefined, { api_secret: this.apiSecret, ...body });
  deleteWebhook = (id: number) => this.request("DELETE", `/automations/hooks/${id}`, { api_secret: this.apiSecret });

  // Purchases
  listPurchases = (params: Json = {}) => this.request("GET", "/purchases", { api_secret: this.apiSecret, ...params });
  getPurchase = (id: number) => this.request("GET", `/purchases/${id}`, { api_secret: this.apiSecret });
  createPurchase = (purchase: Json) => this.request("POST", "/purchases", undefined, { api_secret: this.apiSecret, purchase });
}

async function ctl(method: string, path: string, body?: Json): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
}

let server: ConvertkitServer;
let ck: ConvertKitAxiosSim;

beforeAll(async () => {
  server = new ConvertkitServer(PORT);
  await server.start();
  ck = new ConvertKitAxiosSim(API_KEY, API_SECRET);
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  await ctl("POST", "/__parlel/reset");
});

describe("convertkit: health & control", () => {
  it("responds on /health", async () => {
    const res = await ctl("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: "ok" });
  });

  it("reports state and resets", async () => {
    await ck.createTag("temp");
    const before = await ctl("GET", "/__parlel/state");
    expect(before.data.tags).toBe(1);
    await ctl("POST", "/__parlel/reset");
    const after = await ctl("GET", "/__parlel/state");
    expect(after.data.tags).toBe(0);
    // default seeds remain
    expect(after.data.forms).toBe(2);
    expect(after.data.sequences).toBe(1);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await ctl("GET", "/v3/nonsense");
    expect(res.status).toBe(404);
    expect(res.data.error).toBe("Not Found");
  });

  it("handles OPTIONS preflight", async () => {
    const res = await ctl("OPTIONS", "/v3/forms");
    expect(res.status).toBe(204);
  });

  it("rejects invalid JSON", async () => {
    const response = await fetch(`${BASE_URL}/v3/forms/1/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("convertkit: authentication", () => {
  it("rejects missing api_key on form list", async () => {
    const res = await ctl("GET", "/v3/forms");
    expect(res.status).toBe(401);
    expect(res.data.error).toBe("Authorization Failed");
  });

  it("rejects wrong api_secret on subscribers", async () => {
    const res = await ctl("GET", "/v3/subscribers?api_secret=wrong");
    expect(res.status).toBe(401);
  });

  it("rejects api_key (public) on a secret-only endpoint", async () => {
    const res = await ctl("GET", `/v3/subscribers?api_key=${API_KEY}`);
    expect(res.status).toBe(401);
  });

  it("accepts api_key in the JSON body", async () => {
    const forms = await ck.listForms();
    const formId = forms.data.forms[0].id;
    const res = await ctl("POST", `/v3/forms/${formId}/subscribe`, { api_key: API_KEY, email: "body-auth@parlel.test" });
    expect(res.status).toBe(200);
  });
});

describe("convertkit: account", () => {
  it("GET /account", async () => {
    const res = await ck.getAccount();
    expect(res.status).toBe(200);
    expect(res.data.primary_email_address).toBe("test@parlel.test");
    expect(res.data.name).toBe("Parlel Test");
  });

  it("GET /account/creator_profile", async () => {
    const res = await ck.getCreatorProfile();
    expect(res.status).toBe(200);
    expect(res.data.profile.name).toBe("Parlel Test");
  });

  it("GET /account/growth_stats", async () => {
    const res = await ck.getGrowthStats();
    expect(res.status).toBe(200);
    expect(res.data.stats).toHaveProperty("subscribers");
  });
});

describe("convertkit: forms", () => {
  it("lists seeded forms", async () => {
    const res = await ck.listForms();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.forms)).toBe(true);
    expect(res.data.forms.length).toBe(2);
    expect(res.data.forms[0]).toHaveProperty("embed_url");
  });

  it("subscribes a new subscriber to a form", async () => {
    const forms = await ck.listForms();
    const formId = forms.data.forms[0].id;
    const res = await ck.subscribeToForm(formId, { email: "alice@parlel.test", first_name: "Alice", fields: { city: "NYC" } });
    expect(res.status).toBe(200);
    expect(res.data.subscription.subscribable_type).toBe("form");
    expect(res.data.subscription.subscribable_id).toBe(formId);
    expect(res.data.subscription.subscriber.email_address).toBe("alice@parlel.test");
    expect(res.data.subscription.subscriber.first_name).toBe("Alice");
    expect(res.data.subscription.subscriber.fields.city).toBe("NYC");
  });

  it("upserts the same subscriber across forms (no duplicate)", async () => {
    const forms = await ck.listForms();
    const f1 = forms.data.forms[0].id;
    const f2 = forms.data.forms[1].id;
    const a = await ck.subscribeToForm(f1, { email: "dup@parlel.test" });
    const b = await ck.subscribeToForm(f2, { email: "dup@parlel.test", first_name: "Dup" });
    expect(a.data.subscription.subscriber.id).toBe(b.data.subscription.subscriber.id);
    const state = await ctl("GET", "/__parlel/state");
    expect(state.data.subscribers).toBe(1);
  });

  it("rejects invalid email on subscribe", async () => {
    const forms = await ck.listForms();
    const formId = forms.data.forms[0].id;
    const res = await ck.subscribeToForm(formId, { email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("Bad Request");
  });

  it("404 subscribing to a missing form", async () => {
    const res = await ck.subscribeToForm(999999, { email: "x@parlel.test" });
    expect(res.status).toBe(404);
  });

  it("lists form subscriptions", async () => {
    const forms = await ck.listForms();
    const formId = forms.data.forms[0].id;
    await ck.subscribeToForm(formId, { email: "s1@parlel.test" });
    await ck.subscribeToForm(formId, { email: "s2@parlel.test" });
    const res = await ck.listFormSubscriptions(formId);
    expect(res.status).toBe(200);
    expect(res.data.total_subscriptions).toBe(2);
    expect(res.data.subscriptions.length).toBe(2);
    expect(res.data).toHaveProperty("page");
    expect(res.data).toHaveProperty("total_pages");
  });
});

describe("convertkit: sequences", () => {
  it("lists seeded sequences under courses key", async () => {
    const res = await ck.listSequences();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.courses)).toBe(true);
    expect(res.data.courses.length).toBe(1);
  });

  it("subscribes to a sequence", async () => {
    const seqs = await ck.listSequences();
    const seqId = seqs.data.courses[0].id;
    const res = await ck.subscribeToSequence(seqId, { email: "seq@parlel.test", first_name: "Seq" });
    expect(res.status).toBe(200);
    expect(res.data.subscription.subscribable_type).toBe("course");
    expect(res.data.subscription.subscribable_id).toBe(seqId);
  });

  it("lists sequence subscriptions", async () => {
    const seqs = await ck.listSequences();
    const seqId = seqs.data.courses[0].id;
    await ck.subscribeToSequence(seqId, { email: "seqsub@parlel.test" });
    const res = await ck.listSequenceSubscriptions(seqId);
    expect(res.status).toBe(200);
    expect(res.data.total_subscriptions).toBe(1);
  });

  it("404 for missing sequence subscribe", async () => {
    const res = await ck.subscribeToSequence(888888, { email: "x@parlel.test" });
    expect(res.status).toBe(404);
  });
});

describe("convertkit: tags", () => {
  it("creates a tag (single)", async () => {
    const res = await ck.createTag("VIP");
    expect(res.status).toBe(201);
    expect(res.data.name).toBe("VIP");
    expect(res.data).toHaveProperty("id");
  });

  it("creates a tag from object form", async () => {
    const res = await ck.createTag({ name: "Pro" });
    expect(res.status).toBe(201);
    expect(res.data.name).toBe("Pro");
  });

  it("creates tags in bulk (array response)", async () => {
    const res = await ck.createTagsBulk([{ name: "A" }, { name: "B" }]);
    expect(res.status).toBe(201);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBe(2);
  });

  it("returns existing tag for duplicate name", async () => {
    const a = await ck.createTag("Once");
    const b = await ck.createTag("Once");
    expect(a.data.id).toBe(b.data.id);
  });

  it("rejects tag with no name", async () => {
    const res = await ctl("POST", "/v3/tags", { api_secret: API_SECRET, tag: { name: "" } });
    expect(res.status).toBe(400);
  });

  it("lists tags", async () => {
    await ck.createTag("L1");
    const res = await ck.listTags();
    expect(res.status).toBe(200);
    expect(res.data.tags.some((t: Json) => t.name === "L1")).toBe(true);
  });

  it("subscribes/unsubscribes from a tag and reflects subscriber tags", async () => {
    const tag = await ck.createTag("Engaged");
    const tagId = tag.data.id;
    const sub = await ck.tagSubscribe(tagId, { email: "tagged@parlel.test", first_name: "Tag" });
    expect(sub.status).toBe(200);
    expect(sub.data.subscription.subscribable_type).toBe("tag");

    const subscriberId = sub.data.subscription.subscriber.id;
    const tagsRes = await ck.getSubscriberTags(subscriberId);
    expect(tagsRes.status).toBe(200);
    expect(tagsRes.data.tags.some((t: Json) => t.id === tagId)).toBe(true);

    const subsList = await ck.listTagSubscriptions(tagId);
    expect(subsList.data.total_subscriptions).toBe(1);

    const unsub = await ck.tagUnsubscribe(tagId, "tagged@parlel.test");
    expect(unsub.status).toBe(200);
    expect(unsub.data.subscriber.email_address).toBe("tagged@parlel.test");

    const after = await ck.listTagSubscriptions(tagId);
    expect(after.data.total_subscriptions).toBe(0);
  });

  it("404 on subscribe to missing tag", async () => {
    const res = await ck.tagSubscribe(777777, { email: "x@parlel.test" });
    expect(res.status).toBe(404);
  });
});

describe("convertkit: subscribers", () => {
  async function makeSubscriber(email: string, first_name?: string) {
    const forms = await ck.listForms();
    const formId = forms.data.forms[0].id;
    const r = await ck.subscribeToForm(formId, { email, first_name });
    return r.data.subscription.subscriber.id as number;
  }

  it("lists subscribers with pagination envelope", async () => {
    await makeSubscriber("list1@parlel.test");
    await makeSubscriber("list2@parlel.test");
    const res = await ck.listSubscribers();
    expect(res.status).toBe(200);
    expect(res.data.total_subscribers).toBe(2);
    expect(res.data.page).toBe(1);
    expect(res.data).toHaveProperty("total_pages");
  });

  it("filters subscribers by email_address", async () => {
    await makeSubscriber("findme@parlel.test");
    await makeSubscriber("other@parlel.test");
    const res = await ck.listSubscribers({ email_address: "findme@parlel.test" });
    expect(res.data.total_subscribers).toBe(1);
    expect(res.data.subscribers[0].email_address).toBe("findme@parlel.test");
  });

  it("gets a subscriber by id", async () => {
    const id = await makeSubscriber("getme@parlel.test", "Get");
    const res = await ck.getSubscriber(id);
    expect(res.status).toBe(200);
    expect(res.data.subscriber.email_address).toBe("getme@parlel.test");
    expect(res.data.subscriber.first_name).toBe("Get");
  });

  it("404 for missing subscriber", async () => {
    const res = await ck.getSubscriber(123456);
    expect(res.status).toBe(404);
  });

  it("updates a subscriber (first_name, email, fields)", async () => {
    const id = await makeSubscriber("update@parlel.test", "Before");
    const res = await ck.updateSubscriber(id, { first_name: "After", fields: { plan: "gold" } });
    expect(res.status).toBe(200);
    expect(res.data.subscriber.first_name).toBe("After");
    expect(res.data.subscriber.fields.plan).toBe("gold");
  });

  it("rejects invalid email on update", async () => {
    const id = await makeSubscriber("bademail@parlel.test");
    const res = await ck.updateSubscriber(id, { email_address: "nope" });
    expect(res.status).toBe(400);
  });

  it("unsubscribes a subscriber (state -> cancelled)", async () => {
    await makeSubscriber("cancel@parlel.test");
    const res = await ck.unsubscribe("cancel@parlel.test");
    expect(res.status).toBe(200);
    expect(res.data.subscriber.state).toBe("cancelled");
  });

  it("404 unsubscribing an unknown email", async () => {
    const res = await ck.unsubscribe("ghost@parlel.test");
    expect(res.status).toBe(404);
  });

  it("returns subscriber tags (empty when none)", async () => {
    const id = await makeSubscriber("notags@parlel.test");
    const res = await ck.getSubscriberTags(id);
    expect(res.status).toBe(200);
    expect(res.data.tags).toEqual([]);
  });
});

describe("convertkit: custom fields", () => {
  it("creates a custom field (single)", async () => {
    const res = await ck.createCustomField("Last Name");
    expect(res.status).toBe(201);
    expect(res.data.label).toBe("Last Name");
    expect(res.data).toHaveProperty("key");
    expect(res.data.key).toBe("last_name");
  });

  it("creates custom fields in bulk", async () => {
    const res = await ck.createCustomFieldsBulk(["Birthday", "Phone"]);
    expect(res.status).toBe(201);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBe(2);
  });

  it("rejects blank label", async () => {
    const res = await ck.createCustomField("");
    expect(res.status).toBe(400);
  });

  it("lists custom fields", async () => {
    await ck.createCustomField("Company");
    const res = await ck.listCustomFields();
    expect(res.status).toBe(200);
    expect(res.data.custom_fields.some((f: Json) => f.label === "Company")).toBe(true);
  });

  it("updates a custom field (204)", async () => {
    const created = await ck.createCustomField("Old");
    const res = await ck.updateCustomField(created.data.id, "New");
    expect(res.status).toBe(204);
    const list = await ck.listCustomFields();
    expect(list.data.custom_fields.find((f: Json) => f.id === created.data.id).label).toBe("New");
  });

  it("deletes a custom field (204)", async () => {
    const created = await ck.createCustomField("Temp");
    const res = await ck.deleteCustomField(created.data.id);
    expect(res.status).toBe(204);
    const list = await ck.listCustomFields();
    expect(list.data.custom_fields.some((f: Json) => f.id === created.data.id)).toBe(false);
  });

  it("404 updating a missing custom field", async () => {
    const res = await ck.updateCustomField(999, "X");
    expect(res.status).toBe(404);
  });
});

describe("convertkit: broadcasts", () => {
  it("creates and reads a broadcast", async () => {
    const created = await ck.createBroadcast({ subject: "Hello", content: "<p>Hi</p>" });
    expect(created.status).toBe(201);
    expect(created.data.broadcast.subject).toBe("Hello");
    const id = created.data.broadcast.id;
    const got = await ck.getBroadcast(id);
    expect(got.status).toBe(200);
    expect(got.data.broadcast.content).toBe("<p>Hi</p>");
  });

  it("lists broadcasts (id/subject/created_at)", async () => {
    await ck.createBroadcast({ subject: "One" });
    await ck.createBroadcast({ subject: "Two" });
    const res = await ck.listBroadcasts();
    expect(res.status).toBe(200);
    expect(res.data.broadcasts.length).toBe(2);
    expect(res.data.broadcasts[0]).toHaveProperty("subject");
  });

  it("updates a broadcast", async () => {
    const created = await ck.createBroadcast({ subject: "Draft" });
    const res = await ck.updateBroadcast(created.data.broadcast.id, { subject: "Final", public: true });
    expect(res.status).toBe(200);
    expect(res.data.broadcast.subject).toBe("Final");
    expect(res.data.broadcast.public).toBe(true);
  });

  it("gets broadcast stats", async () => {
    const created = await ck.createBroadcast({ subject: "Stats" });
    const res = await ck.getBroadcastStats(created.data.broadcast.id);
    expect(res.status).toBe(200);
    expect(res.data.broadcast.stats).toHaveProperty("recipients");
    expect(res.data.broadcast.stats).toHaveProperty("open_rate");
  });

  it("deletes a broadcast (204)", async () => {
    const created = await ck.createBroadcast({ subject: "Bye" });
    const res = await ck.deleteBroadcast(created.data.broadcast.id);
    expect(res.status).toBe(204);
    const got = await ck.getBroadcast(created.data.broadcast.id);
    expect(got.status).toBe(404);
  });

  it("404 for missing broadcast", async () => {
    const res = await ck.getBroadcast(424242);
    expect(res.status).toBe(404);
  });
});

describe("convertkit: webhooks (automations/hooks)", () => {
  it("creates a webhook rule", async () => {
    const res = await ck.createWebhook({
      target_url: "https://parlel.test/hook",
      event: { name: "subscriber.subscriber_activate" },
    });
    expect(res.status).toBe(200);
    expect(res.data.rule.target_url).toBe("https://parlel.test/hook");
    expect(res.data.rule).toHaveProperty("id");
  });

  it("rejects webhook with no target_url", async () => {
    const res = await ck.createWebhook({ event: { name: "x" } });
    expect(res.status).toBe(400);
  });

  it("deletes a webhook", async () => {
    const created = await ck.createWebhook({ target_url: "https://parlel.test/hook2" });
    const res = await ck.deleteWebhook(created.data.rule.id);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("404 deleting an unknown webhook", async () => {
    const res = await ck.deleteWebhook(999999);
    expect(res.status).toBe(404);
  });
});

describe("convertkit: purchases", () => {
  it("creates a purchase", async () => {
    const res = await ck.createPurchase({
      transaction_id: "txn_1",
      email_address: "buyer@parlel.test",
      currency: "USD",
      total: 1999,
      products: [{ name: "Course", pid: 1, lid: 1, unit_price: 1999, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.data.transaction_id).toBe("txn_1");
    expect(res.data.status).toBe("paid");
    expect(res.data.products.length).toBe(1);
  });

  it("creates a subscriber from a purchase", async () => {
    await ck.createPurchase({ transaction_id: "txn_2", email_address: "newbuyer@parlel.test" });
    const subs = await ck.listSubscribers({ email_address: "newbuyer@parlel.test" });
    expect(subs.data.total_subscribers).toBe(1);
  });

  it("rejects a purchase with missing transaction_id", async () => {
    const res = await ck.createPurchase({ email_address: "buyer@parlel.test" });
    expect(res.status).toBe(422);
  });

  it("rejects a purchase with invalid email", async () => {
    const res = await ck.createPurchase({ transaction_id: "txn_3", email_address: "bad" });
    expect(res.status).toBe(422);
  });

  it("lists and gets purchases", async () => {
    const created = await ck.createPurchase({ transaction_id: "txn_4", email_address: "list@parlel.test" });
    const list = await ck.listPurchases();
    expect(list.status).toBe(200);
    expect(list.data.total_purchases).toBe(1);
    expect(list.data).toHaveProperty("page");
    const got = await ck.getPurchase(created.data.id);
    expect(got.status).toBe(200);
    expect(got.data.transaction_id).toBe("txn_4");
  });

  it("404 for missing purchase", async () => {
    const res = await ck.getPurchase(999999);
    expect(res.status).toBe(404);
  });
});

describe("convertkit: method handling", () => {
  it("405 for unsupported method on a known resource", async () => {
    const res = await ctl("DELETE", `/v3/forms?api_key=${API_KEY}`);
    expect(res.status).toBe(405);
  });
});
