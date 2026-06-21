import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { KlaviyoServer } from "../services/klaviyo/src/server.js";

const PORT = 14658;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PRIVATE_KEY = "pk_parlel_test_private_key";
const PUBLIC_KEY = "PARLEL";
const REVISION = "2024-10-15";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

const AUTH = { Authorization: `Klaviyo-Key ${PRIVATE_KEY}`, revision: REVISION };

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
 * Faithful re-implementation of how application code drives the Klaviyo REST
 * API with `axios`. The documented pattern is:
 *
 *   const klaviyo = axios.create({
 *     baseURL: "https://a.klaviyo.com/api",
 *     headers: {
 *       Authorization: `Klaviyo-Key ${apiKey}`,
 *       revision: "2024-10-15",
 *       "Content-Type": "application/json",
 *       Accept: "application/json",
 *     },
 *   });
 *   await klaviyo.post("/profiles/", { data: { type: "profile", attributes: {...} } });
 *
 * This sim mirrors that exact request shape on the wire (JSON:API body,
 * Klaviyo-Key auth, revision header), exercising the precise protocol the real
 * axios client speaks — with zero external dependencies.
 */
class KlaviyoAxiosSim {
  constructor(private apiKey: string, private baseUrl = `${BASE_URL}/api`) {}

  private async request(method: string, path: string, data?: any) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-Key ${this.apiKey}`,
        revision: REVISION,
        Accept: "application/json",
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    // axios throws on >= 400; emulate by returning a typed result the tests check.
    return { status: response.status, data: parsed };
  }

  // Profiles
  getProfiles = (query = "") => this.request("GET", `/profiles/${query}`);
  getProfile = (id: string) => this.request("GET", `/profiles/${id}/`);
  createProfile = (attributes: Json) => this.request("POST", "/profiles/", { data: { type: "profile", attributes } });
  updateProfile = (id: string, attributes: Json) => this.request("PATCH", `/profiles/${id}/`, { data: { type: "profile", id, attributes } });
  importProfile = (attributes: Json) => this.request("POST", "/profile-import/", { data: { type: "profile", attributes } });

  // Lists
  getLists = () => this.request("GET", "/lists/");
  getList = (id: string) => this.request("GET", `/lists/${id}/`);
  createList = (name: string) => this.request("POST", "/lists/", { data: { type: "list", attributes: { name } } });
  updateList = (id: string, name: string) => this.request("PATCH", `/lists/${id}/`, { data: { type: "list", id, attributes: { name } } });
  deleteList = (id: string) => this.request("DELETE", `/lists/${id}/`);
  getListProfiles = (id: string) => this.request("GET", `/lists/${id}/profiles/`);
  addToList = (id: string, profileIds: string[]) =>
    this.request("POST", `/lists/${id}/relationships/profiles/`, { data: profileIds.map((pid) => ({ type: "profile", id: pid })) });
  removeFromList = (id: string, profileIds: string[]) =>
    this.request("DELETE", `/lists/${id}/relationships/profiles/`, { data: profileIds.map((pid) => ({ type: "profile", id: pid })) });

  // Segments
  getSegments = () => this.request("GET", "/segments/");
  getSegment = (id: string) => this.request("GET", `/segments/${id}/`);
  getSegmentProfiles = (id: string) => this.request("GET", `/segments/${id}/profiles/`);

  // Events
  createEvent = (data: Json) => this.request("POST", "/events/", { data });
  getEvents = (query = "") => this.request("GET", `/events/${query}`);
  getEvent = (id: string) => this.request("GET", `/events/${id}/`);

  // Metrics
  getMetrics = () => this.request("GET", "/metrics/");
  getMetric = (id: string) => this.request("GET", `/metrics/${id}/`);
  queryMetricAggregates = (attributes: Json) => this.request("POST", "/metric-aggregates/", { data: { type: "metric-aggregate", attributes } });

  // Campaigns
  getCampaigns = () => this.request("GET", "/campaigns/?filter=equals(messages.channel,'email')");
  getCampaign = (id: string) => this.request("GET", `/campaigns/${id}/`);
  createCampaign = (attributes: Json) => this.request("POST", "/campaigns/", { data: { type: "campaign", attributes } });
  updateCampaign = (id: string, attributes: Json) => this.request("PATCH", `/campaigns/${id}/`, { data: { type: "campaign", id, attributes } });
  deleteCampaign = (id: string) => this.request("DELETE", `/campaigns/${id}/`);
  sendCampaign = (id: string) => this.request("POST", "/campaign-send-jobs/", { data: { type: "campaign-send-job", id } });

  // Templates
  getTemplates = () => this.request("GET", "/templates/");
  getTemplate = (id: string) => this.request("GET", `/templates/${id}/`);
  createTemplate = (attributes: Json) => this.request("POST", "/templates/", { data: { type: "template", attributes } });
  updateTemplate = (id: string, attributes: Json) => this.request("PATCH", `/templates/${id}/`, { data: { type: "template", id, attributes } });
  deleteTemplate = (id: string) => this.request("DELETE", `/templates/${id}/`);

  // Tags
  getTags = () => this.request("GET", "/tags/");
  getTag = (id: string) => this.request("GET", `/tags/${id}/`);
  createTag = (name: string) => this.request("POST", "/tags/", { data: { type: "tag", attributes: { name } } });
  updateTag = (id: string, name: string) => this.request("PATCH", `/tags/${id}/`, { data: { type: "tag", id, attributes: { name } } });
  deleteTag = (id: string) => this.request("DELETE", `/tags/${id}/`);

  // Flows
  getFlows = () => this.request("GET", "/flows/");
  getFlow = (id: string) => this.request("GET", `/flows/${id}/`);

  // Accounts
  getAccounts = () => this.request("GET", "/accounts/");
}

let server: KlaviyoServer;
let kv: KlaviyoAxiosSim;

beforeAll(async () => {
  server = new KlaviyoServer(PORT);
  await server.start();
  kv = new KlaviyoAxiosSim(PRIVATE_KEY);
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  await api("POST", "/__parlel/reset", undefined, {});
});

describe("infrastructure", () => {
  it("responds to health check without auth", async () => {
    const res = await api("GET", "/health", undefined, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects /api requests without auth", async () => {
    const res = await api("GET", "/api/profiles/", undefined, {});
    expect(res.status).toBe(401);
    expect(res.body.errors[0].code).toBe("not_authenticated");
  });

  it("accepts Klaviyo-Key auth", async () => {
    const res = await kv.getProfiles();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it("returns 404 for unknown /api resources", async () => {
    const res = await api("GET", "/api/nonexistent/", undefined, AUTH);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe("not_found");
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await fetch(`${BASE_URL}/api/profiles/`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
  });

  it("reports state via /__parlel/state", async () => {
    const res = await api("GET", "/__parlel/state", undefined, {});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("profiles");
    expect(res.body).toHaveProperty("metrics");
  });
});

describe("accounts", () => {
  it("lists accounts", async () => {
    const res = await kv.getAccounts();
    expect(res.status).toBe(200);
    expect(res.data.data[0].type).toBe("account");
    expect(res.data.data[0].attributes.public_api_key).toBe(PUBLIC_KEY);
  });

  it("gets a single account by id", async () => {
    const res = await api("GET", "/api/accounts/PARLEL/", undefined, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("PARLEL");
  });

  it("404s for an unknown account id", async () => {
    const res = await api("GET", "/api/accounts/NOPE/", undefined, AUTH);
    expect(res.status).toBe(404);
  });
});

describe("profiles", () => {
  it("creates a profile", async () => {
    const res = await kv.createProfile({ email: "a@parlel.test", first_name: "Ada" });
    expect(res.status).toBe(201);
    expect(res.data.data.type).toBe("profile");
    expect(res.data.data.attributes.email).toBe("a@parlel.test");
    expect(res.data.data.id).toBeTruthy();
    expect(res.data.data.relationships.lists).toBeTruthy();
  });

  it("rejects an invalid email", async () => {
    const res = await kv.createProfile({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.data.errors[0].code).toBe("invalid");
  });

  it("rejects a payload with the wrong type", async () => {
    const res = await api("POST", "/api/profiles/", { data: { type: "widget", attributes: {} } }, AUTH);
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate email", async () => {
    await kv.createProfile({ email: "dup@parlel.test" });
    const res = await kv.createProfile({ email: "dup@parlel.test" });
    expect(res.status).toBe(409);
    expect(res.data.errors[0].code).toBe("duplicate_profile");
    expect(res.data.errors[0].meta.duplicate_profile_id).toBeTruthy();
  });

  it("gets a profile by id", async () => {
    const created = await kv.createProfile({ email: "get@parlel.test" });
    const res = await kv.getProfile(created.data.data.id);
    expect(res.status).toBe(200);
    expect(res.data.data.attributes.email).toBe("get@parlel.test");
  });

  it("404s for an unknown profile", async () => {
    const res = await kv.getProfile("does-not-exist");
    expect(res.status).toBe(404);
    expect(res.data.errors[0].code).toBe("not_found");
  });

  it("updates a profile", async () => {
    const created = await kv.createProfile({ email: "upd@parlel.test", first_name: "Old" });
    const res = await kv.updateProfile(created.data.data.id, { first_name: "New", properties: { plan: "pro" } });
    expect(res.status).toBe(200);
    expect(res.data.data.attributes.first_name).toBe("New");
    expect(res.data.data.attributes.properties.plan).toBe("pro");
  });

  it("rejects update with mismatched id", async () => {
    const created = await kv.createProfile({ email: "mm@parlel.test" });
    const res = await api("PATCH", `/api/profiles/${created.data.data.id}/`, { data: { type: "profile", id: "other", attributes: {} } }, AUTH);
    expect(res.status).toBe(400);
  });

  it("lists profiles", async () => {
    await kv.createProfile({ email: "l1@parlel.test" });
    await kv.createProfile({ email: "l2@parlel.test" });
    const res = await kv.getProfiles();
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBe(2);
  });

  it("filters profiles by email", async () => {
    await kv.createProfile({ email: "find@parlel.test" });
    await kv.createProfile({ email: "other@parlel.test" });
    const res = await kv.getProfiles(`?filter=${encodeURIComponent('equals(email,"find@parlel.test")')}`);
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBe(1);
    expect(res.data.data[0].attributes.email).toBe("find@parlel.test");
  });

  it("imports (upserts) a profile — create then update", async () => {
    const first = await kv.importProfile({ email: "imp@parlel.test", first_name: "One" });
    expect(first.status).toBe(201);
    const second = await kv.importProfile({ email: "imp@parlel.test", last_name: "Two" });
    expect(second.status).toBe(200);
    expect(second.data.data.attributes.first_name).toBe("One");
    expect(second.data.data.attributes.last_name).toBe("Two");
  });

  it("runs a subscription bulk create job", async () => {
    const res = await api("POST", "/api/profile-subscription-bulk-create-jobs/", {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          profiles: { data: [{ type: "profile", attributes: { email: "sub@parlel.test", subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } } } }] },
        },
      },
    }, AUTH);
    expect(res.status).toBe(202);
    const state = await api("GET", "/__parlel/state", undefined, {});
    expect(state.body.profiles).toBe(1);
  });

  it("runs a suppression bulk create job", async () => {
    const res = await api("POST", "/api/profile-suppression-bulk-create-jobs/", {
      data: { type: "profile-suppression-bulk-create-job", attributes: { profiles: { data: [{ type: "profile", attributes: { email: "supp@parlel.test" } }] } } },
    }, AUTH);
    expect(res.status).toBe(202);
  });
});

describe("lists", () => {
  it("creates a list", async () => {
    const res = await kv.createList("Newsletter");
    expect(res.status).toBe(201);
    expect(res.data.data.type).toBe("list");
    expect(res.data.data.attributes.name).toBe("Newsletter");
  });

  it("rejects a list with no name", async () => {
    const res = await api("POST", "/api/lists/", { data: { type: "list", attributes: {} } }, AUTH);
    expect(res.status).toBe(400);
  });

  it("gets a list", async () => {
    const created = await kv.createList("Get Me");
    const res = await kv.getList(created.data.data.id);
    expect(res.status).toBe(200);
    expect(res.data.data.attributes.name).toBe("Get Me");
  });

  it("404s for unknown list", async () => {
    const res = await kv.getList("NOPE");
    expect(res.status).toBe(404);
  });

  it("lists lists", async () => {
    await kv.createList("A");
    await kv.createList("B");
    const res = await kv.getLists();
    expect(res.data.data.length).toBe(2);
  });

  it("updates a list", async () => {
    const created = await kv.createList("Old Name");
    const res = await kv.updateList(created.data.data.id, "New Name");
    expect(res.status).toBe(200);
    expect(res.data.data.attributes.name).toBe("New Name");
  });

  it("deletes a list", async () => {
    const created = await kv.createList("Delete Me");
    const res = await kv.deleteList(created.data.data.id);
    expect(res.status).toBe(204);
    const after = await kv.getList(created.data.data.id);
    expect(after.status).toBe(404);
  });

  it("adds and removes profiles from a list", async () => {
    const list = await kv.createList("Members");
    const p1 = await kv.createProfile({ email: "m1@parlel.test" });
    const p2 = await kv.createProfile({ email: "m2@parlel.test" });
    const listId = list.data.data.id;

    const add = await kv.addToList(listId, [p1.data.data.id, p2.data.data.id]);
    expect(add.status).toBe(204);

    const members = await kv.getListProfiles(listId);
    expect(members.status).toBe(200);
    expect(members.data.data.length).toBe(2);

    const rm = await kv.removeFromList(listId, [p1.data.data.id]);
    expect(rm.status).toBe(204);

    const after = await kv.getListProfiles(listId);
    expect(after.data.data.length).toBe(1);
  });

  it("404s when adding a non-existent profile to a list", async () => {
    const list = await kv.createList("Bad Add");
    const res = await kv.addToList(list.data.data.id, ["ghost"]);
    expect(res.status).toBe(404);
  });
});

describe("segments", () => {
  it("lists segments (empty by default)", async () => {
    const res = await kv.getSegments();
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBe(0);
  });

  it("creates and gets a segment", async () => {
    const created = await api("POST", "/api/segments/", { data: { type: "segment", attributes: { name: "VIPs" } } }, AUTH);
    expect(created.status).toBe(201);
    const res = await kv.getSegment(created.body.data.id);
    expect(res.status).toBe(200);
    expect(res.data.data.attributes.name).toBe("VIPs");
  });

  it("404s for unknown segment", async () => {
    const res = await kv.getSegment("NOPE");
    expect(res.status).toBe(404);
  });

  it("lists profiles in a seeded segment", async () => {
    const p = await kv.createProfile({ email: "seg@parlel.test" });
    const seed = await api("POST", "/__parlel/seed/segment", { attributes: { name: "Seeded", profileIds: [p.data.data.id] } }, {});
    const segId = seed.body.data.id;
    const res = await kv.getSegmentProfiles(segId);
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBe(1);
    expect(res.data.data[0].attributes.email).toBe("seg@parlel.test");
  });
});

describe("events & metrics", () => {
  it("creates an event (returns 202) and upserts a profile + metric", async () => {
    const res = await kv.createEvent({
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: "Viewed Product" } } },
        profile: { data: { type: "profile", attributes: { email: "ev@parlel.test" } } },
        properties: { ProductName: "Widget" },
        value: 9.99,
      },
    });
    expect(res.status).toBe(202);
    const state = await api("GET", "/__parlel/state", undefined, {});
    expect(state.body.events).toBe(1);
    expect(state.body.profiles).toBe(1);
  });

  it("rejects an event with no metric", async () => {
    const res = await kv.createEvent({ type: "event", attributes: { profile: { data: { type: "profile", attributes: { email: "x@parlel.test" } } } } });
    expect(res.status).toBe(400);
  });

  it("rejects an event with no profile identifier", async () => {
    const res = await kv.createEvent({ type: "event", attributes: { metric: { data: { type: "metric", attributes: { name: "M" } } }, profile: { data: { type: "profile", attributes: {} } } } });
    expect(res.status).toBe(400);
  });

  it("lists and gets events", async () => {
    await kv.createEvent({
      type: "event",
      attributes: { metric: { data: { type: "metric", attributes: { name: "Clicked" } } }, profile: { data: { type: "profile", attributes: { email: "list-ev@parlel.test" } } } },
    });
    const list = await kv.getEvents();
    expect(list.status).toBe(200);
    expect(list.data.data.length).toBe(1);
    const id = list.data.data[0].id;
    const single = await kv.getEvent(id);
    expect(single.status).toBe(200);
    expect(single.data.data.relationships.metric.data.type).toBe("metric");
  });

  it("404s for an unknown event", async () => {
    const res = await kv.getEvent("nope");
    expect(res.status).toBe(404);
  });

  it("lists metrics including built-ins", async () => {
    const res = await kv.getMetrics();
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeGreaterThanOrEqual(2);
    const names = res.data.data.map((m: any) => m.attributes.name);
    expect(names).toContain("Placed Order");
  });

  it("gets a metric by id", async () => {
    const metrics = await kv.getMetrics();
    const id = metrics.data.data[0].id;
    const res = await kv.getMetric(id);
    expect(res.status).toBe(200);
    expect(res.data.data.id).toBe(id);
  });

  it("404s for unknown metric", async () => {
    const res = await kv.getMetric("NOPE");
    expect(res.status).toBe(404);
  });

  it("queries metric aggregates", async () => {
    await kv.createEvent({
      type: "event",
      attributes: { metric: { data: { type: "metric", attributes: { name: "Aggregated" } } }, profile: { data: { type: "profile", attributes: { email: "agg@parlel.test" } } } },
    });
    const metrics = await kv.getMetrics();
    const metricId = metrics.data.data.find((m: any) => m.attributes.name === "Aggregated").id;
    const res = await kv.queryMetricAggregates({ metric_id: metricId, measurements: ["count"], interval: "day" });
    expect(res.status).toBe(200);
    expect(res.data.data.type).toBe("metric-aggregate");
    expect(res.data.data.attributes.data[0].measurements.count[0]).toBe(1);
  });

  it("rejects metric aggregates with an invalid metric_id", async () => {
    const res = await kv.queryMetricAggregates({ metric_id: "NOPE", measurements: ["count"] });
    expect(res.status).toBe(400);
  });
});

describe("campaigns", () => {
  const campaignAttrs = () => ({
    name: "Launch",
    audiences: { included: ["LISTID"], excluded: [] },
    send_strategy: { method: "immediate" },
    "campaign-messages": { data: [] },
  });

  it("creates a campaign", async () => {
    const res = await kv.createCampaign(campaignAttrs());
    expect(res.status).toBe(201);
    expect(res.data.data.attributes.name).toBe("Launch");
    expect(res.data.data.attributes.status).toBe("Draft");
  });

  it("rejects a campaign with no name", async () => {
    const res = await api("POST", "/api/campaigns/", { data: { type: "campaign", attributes: {} } }, AUTH);
    expect(res.status).toBe(400);
  });

  it("gets, lists, updates and deletes a campaign", async () => {
    const created = await kv.createCampaign(campaignAttrs());
    const id = created.data.data.id;

    const got = await kv.getCampaign(id);
    expect(got.status).toBe(200);

    const list = await kv.getCampaigns();
    expect(list.status).toBe(200);
    expect(list.data.data.length).toBe(1);

    const upd = await kv.updateCampaign(id, { name: "Renamed" });
    expect(upd.status).toBe(200);
    expect(upd.data.data.attributes.name).toBe("Renamed");

    const del = await kv.deleteCampaign(id);
    expect(del.status).toBe(204);
    const after = await kv.getCampaign(id);
    expect(after.status).toBe(404);
  });

  it("sends a campaign via campaign-send-jobs", async () => {
    const created = await kv.createCampaign(campaignAttrs());
    const id = created.data.data.id;
    const res = await kv.sendCampaign(id);
    expect(res.status).toBe(202);
    const after = await kv.getCampaign(id);
    expect(after.data.data.attributes.status).toBe("Sent");
  });

  it("404s when sending an unknown campaign", async () => {
    const res = await kv.sendCampaign("ghost");
    expect(res.status).toBe(404);
  });
});

describe("templates", () => {
  it("creates a template", async () => {
    const res = await kv.createTemplate({ name: "Welcome", html: "<h1>Hi</h1>", editor_type: "CODE" });
    expect(res.status).toBe(201);
    expect(res.data.data.attributes.html).toBe("<h1>Hi</h1>");
  });

  it("rejects a template with no name", async () => {
    const res = await api("POST", "/api/templates/", { data: { type: "template", attributes: {} } }, AUTH);
    expect(res.status).toBe(400);
  });

  it("gets, lists, updates and deletes a template", async () => {
    const created = await kv.createTemplate({ name: "T", html: "<p>a</p>" });
    const id = created.data.data.id;

    expect((await kv.getTemplate(id)).status).toBe(200);
    expect((await kv.getTemplates()).data.data.length).toBe(1);

    const upd = await kv.updateTemplate(id, { html: "<p>b</p>" });
    expect(upd.status).toBe(200);
    expect(upd.data.data.attributes.html).toBe("<p>b</p>");

    expect((await kv.deleteTemplate(id)).status).toBe(204);
    expect((await kv.getTemplate(id)).status).toBe(404);
  });
});

describe("tags", () => {
  it("creates a tag", async () => {
    const res = await kv.createTag("vip");
    expect(res.status).toBe(201);
    expect(res.data.data.attributes.name).toBe("vip");
  });

  it("rejects a tag with no name", async () => {
    const res = await api("POST", "/api/tags/", { data: { type: "tag", attributes: {} } }, AUTH);
    expect(res.status).toBe(400);
  });

  it("gets, lists, updates (204) and deletes a tag", async () => {
    const created = await kv.createTag("old");
    const id = created.data.data.id;

    expect((await kv.getTag(id)).status).toBe(200);
    expect((await kv.getTags()).data.data.length).toBe(1);

    const upd = await kv.updateTag(id, "new");
    expect(upd.status).toBe(204);
    expect((await kv.getTag(id)).data.data.attributes.name).toBe("new");

    expect((await kv.deleteTag(id)).status).toBe(204);
    expect((await kv.getTag(id)).status).toBe(404);
  });
});

describe("flows", () => {
  it("lists flows (empty by default)", async () => {
    const res = await kv.getFlows();
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBe(0);
  });

  it("gets a seeded flow", async () => {
    const seed = await api("POST", "/__parlel/seed/flow", { attributes: { name: "Welcome Flow" } }, {});
    const res = await kv.getFlow(seed.body.data.id);
    expect(res.status).toBe(200);
    expect(res.data.data.attributes.name).toBe("Welcome Flow");
  });

  it("404s for unknown flow", async () => {
    const res = await kv.getFlow("NOPE");
    expect(res.status).toBe(404);
  });
});

describe("client (public) endpoints", () => {
  const clientUrl = (ep: string) => `/client/${ep}/?company_id=${PUBLIC_KEY}`;

  it("requires company_id", async () => {
    const res = await api("POST", "/client/events/", { data: { type: "event" } }, {});
    expect(res.status).toBe(400);
  });

  it("tracks a public event", async () => {
    const res = await api("POST", clientUrl("events"), {
      data: { type: "event", attributes: { metric: { data: { type: "metric", attributes: { name: "Viewed" } } }, profile: { data: { type: "profile", attributes: { email: "pub@parlel.test" } } } } },
    }, {});
    expect(res.status).toBe(202);
    const state = await api("GET", "/__parlel/state", undefined, {});
    expect(state.body.events).toBe(1);
  });

  it("identifies a public profile", async () => {
    const res = await api("POST", clientUrl("profiles"), {
      data: { type: "profile", attributes: { email: "pubprof@parlel.test", properties: { source: "web" } } },
    }, {});
    expect(res.status).toBe(202);
    const state = await api("GET", "/__parlel/state", undefined, {});
    expect(state.body.profiles).toBe(1);
  });

  it("creates a client subscription", async () => {
    const res = await api("POST", clientUrl("subscriptions"), {
      data: { type: "subscription", attributes: { profile: { data: { type: "profile", attributes: { email: "subscribe@parlel.test" } } } } },
    }, {});
    expect(res.status).toBe(202);
  });

  it("registers a push token", async () => {
    const res = await api("POST", clientUrl("push-tokens"), {
      data: { type: "push-token", attributes: { token: "abc123", platform: "ios", profile: { data: { type: "profile", attributes: { email: "push@parlel.test" } } } } },
    }, {});
    expect(res.status).toBe(202);
  });
});

describe("control / reset", () => {
  it("resets all state via /__parlel/reset", async () => {
    await kv.createProfile({ email: "reset@parlel.test" });
    await kv.createList("Temp");
    const reset = await api("POST", "/__parlel/reset", undefined, {});
    expect(reset.status).toBe(200);
    const state = await api("GET", "/__parlel/state", undefined, {});
    expect(state.body.profiles).toBe(0);
    expect(state.body.lists).toBe(0);
  });
});
