import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { MailchimpServer } from "../services/mailchimp/src/server.js";

const PORT = 14653;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestKey-us1";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

// The official client authenticates with HTTP Basic auth using
// base64("anystring:apikey"). Mirror that exactly.
function basicAuth(): string {
  return "Basic " + Buffer.from(`anystring:${API_KEY}`).toString("base64");
}

async function api(method: string, path: string, body?: any, headers: Json = { Authorization: basicAuth() }): Promise<ApiResult> {
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

function subscriberHash(email: string): string {
  return createHash("md5").update(email.toLowerCase()).digest("hex");
}

/**
 * Faithful re-implementation of how the official
 * `@mailchimp/mailchimp_marketing` Node.js client builds and dispatches
 * requests. The real client prefixes every path with `/3.0`, uses HTTP Basic
 * auth, exposes namespaces like `mailchimp.lists`, `mailchimp.campaigns`,
 * `mailchimp.ping`, etc, and throws on non-2xx (the error has `.status` and
 * `.response.body`). This mirrors that wire protocol with zero external deps.
 */
class MailchimpClientSim {
  constructor(private apiKey: string, private baseUrl = `${BASE_URL}/3.0`) {}

  private async request(method: string, path: string, body?: any, queryParams: Json = {}) {
    const qs = new URLSearchParams(
      Object.entries(queryParams).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from(`anystring:${this.apiKey}`).toString("base64"),
        "User-Agent": "@mailchimp/mailchimp_marketing:sim",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (response.status >= 400) {
      const err: any = new Error(parsed?.detail || "Mailchimp API error");
      err.status = response.status;
      err.response = { body: parsed };
      throw err;
    }
    return parsed;
  }

  root = { getRoot: () => this.request("GET", "/") };
  ping = { get: () => this.request("GET", "/ping") };

  searchMembers = { search: (q: Json) => this.request("GET", "/search-members", undefined, q) };
  searchCampaigns = { search: (q: Json) => this.request("GET", "/search-campaigns", undefined, q) };

  lists = {
    getAllLists: (q: Json = {}) => this.request("GET", "/lists", undefined, q),
    createList: (b: Json) => this.request("POST", "/lists", b),
    getList: (id: string) => this.request("GET", `/lists/${id}`),
    updateList: (id: string, b: Json) => this.request("PATCH", `/lists/${id}`, b),
    deleteList: (id: string) => this.request("DELETE", `/lists/${id}`),
    batchListMembers: (id: string, b: Json) => this.request("POST", `/lists/${id}`, b),

    getListMembersInfo: (id: string, q: Json = {}) => this.request("GET", `/lists/${id}/members`, undefined, q),
    addListMember: (id: string, b: Json) => this.request("POST", `/lists/${id}/members`, b),
    getListMember: (id: string, hash: string) => this.request("GET", `/lists/${id}/members/${hash}`),
    setListMember: (id: string, hash: string, b: Json) => this.request("PUT", `/lists/${id}/members/${hash}`, b),
    updateListMember: (id: string, hash: string, b: Json) => this.request("PATCH", `/lists/${id}/members/${hash}`, b),
    deleteListMember: (id: string, hash: string) => this.request("DELETE", `/lists/${id}/members/${hash}`),
    deleteListMemberPermanent: (id: string, hash: string) => this.request("POST", `/lists/${id}/members/${hash}/actions/delete-permanent`),

    getListMemberTags: (id: string, hash: string) => this.request("GET", `/lists/${id}/members/${hash}/tags`),
    updateListMemberTags: (id: string, hash: string, b: Json) => this.request("POST", `/lists/${id}/members/${hash}/tags`, b),

    getListMemberNotes: (id: string, hash: string) => this.request("GET", `/lists/${id}/members/${hash}/notes`),
    createListMemberNote: (id: string, hash: string, b: Json) => this.request("POST", `/lists/${id}/members/${hash}/notes`, b),
    getListMemberNote: (id: string, hash: string, noteId: string) => this.request("GET", `/lists/${id}/members/${hash}/notes/${noteId}`),
    updateListMemberNote: (id: string, hash: string, noteId: string, b: Json) => this.request("PATCH", `/lists/${id}/members/${hash}/notes/${noteId}`, b),
    deleteListMemberNote: (id: string, hash: string, noteId: string) => this.request("DELETE", `/lists/${id}/members/${hash}/notes/${noteId}`),

    getListMergeFields: (id: string) => this.request("GET", `/lists/${id}/merge-fields`),
    addListMergeField: (id: string, b: Json) => this.request("POST", `/lists/${id}/merge-fields`, b),
    getListMergeField: (id: string, mid: string) => this.request("GET", `/lists/${id}/merge-fields/${mid}`),
    updateListMergeField: (id: string, mid: string, b: Json) => this.request("PATCH", `/lists/${id}/merge-fields/${mid}`, b),
    deleteListMergeField: (id: string, mid: string) => this.request("DELETE", `/lists/${id}/merge-fields/${mid}`),

    listSegments: (id: string) => this.request("GET", `/lists/${id}/segments`),
    createSegment: (id: string, b: Json) => this.request("POST", `/lists/${id}/segments`, b),
    getSegment: (id: string, sid: string) => this.request("GET", `/lists/${id}/segments/${sid}`),
    updateSegment: (id: string, sid: string, b: Json) => this.request("PATCH", `/lists/${id}/segments/${sid}`, b),
    deleteSegment: (id: string, sid: string) => this.request("DELETE", `/lists/${id}/segments/${sid}`),
    batchSegmentMembers: (b: Json, id: string, sid: string) => this.request("POST", `/lists/${id}/segments/${sid}`, b),
    getSegmentMembersList: (id: string, sid: string) => this.request("GET", `/lists/${id}/segments/${sid}/members`),
    createSegmentMember: (id: string, sid: string, b: Json) => this.request("POST", `/lists/${id}/segments/${sid}/members`, b),
    removeSegmentMember: (id: string, sid: string, hash: string) => this.request("DELETE", `/lists/${id}/segments/${sid}/members/${hash}`),

    getListInterestCategories: (id: string) => this.request("GET", `/lists/${id}/interest-categories`),
    createListInterestCategory: (id: string, b: Json) => this.request("POST", `/lists/${id}/interest-categories`, b),
    getInterestCategory: (id: string, cid: string) => this.request("GET", `/lists/${id}/interest-categories/${cid}`),
    updateInterestCategory: (id: string, cid: string, b: Json) => this.request("PATCH", `/lists/${id}/interest-categories/${cid}`, b),
    deleteInterestCategory: (id: string, cid: string) => this.request("DELETE", `/lists/${id}/interest-categories/${cid}`),
    listInterestCategoryInterests: (id: string, cid: string) => this.request("GET", `/lists/${id}/interest-categories/${cid}/interests`),
    createInterestCategoryInterest: (id: string, cid: string, b: Json) => this.request("POST", `/lists/${id}/interest-categories/${cid}/interests`, b),
    getInterestCategoryInterest: (id: string, cid: string, iid: string) => this.request("GET", `/lists/${id}/interest-categories/${cid}/interests/${iid}`),
    updateInterestCategoryInterest: (id: string, cid: string, iid: string, b: Json) => this.request("PATCH", `/lists/${id}/interest-categories/${cid}/interests/${iid}`, b),
    deleteInterestCategoryInterest: (id: string, cid: string, iid: string) => this.request("DELETE", `/lists/${id}/interest-categories/${cid}/interests/${iid}`),

    getListWebhooks: (id: string) => this.request("GET", `/lists/${id}/webhooks`),
    createListWebhook: (id: string, b: Json) => this.request("POST", `/lists/${id}/webhooks`, b),
    getListWebhook: (id: string, wid: string) => this.request("GET", `/lists/${id}/webhooks/${wid}`),
    updateListWebhook: (id: string, wid: string, b: Json) => this.request("PATCH", `/lists/${id}/webhooks/${wid}`, b),
    deleteListWebhook: (id: string, wid: string) => this.request("DELETE", `/lists/${id}/webhooks/${wid}`),

    getListGrowthHistory: (id: string) => this.request("GET", `/lists/${id}/growth-history`),
    getListActivity: (id: string) => this.request("GET", `/lists/${id}/activity`),
    getListClients: (id: string) => this.request("GET", `/lists/${id}/clients`),
    getListLocations: (id: string) => this.request("GET", `/lists/${id}/locations`),
    tagSearch: (id: string, q: Json = {}) => this.request("GET", `/lists/${id}/tag-search`, undefined, q),
  };

  campaigns = {
    list: (q: Json = {}) => this.request("GET", "/campaigns", undefined, q),
    create: (b: Json) => this.request("POST", "/campaigns", b),
    get: (id: string) => this.request("GET", `/campaigns/${id}`),
    update: (id: string, b: Json) => this.request("PATCH", `/campaigns/${id}`, b),
    remove: (id: string) => this.request("DELETE", `/campaigns/${id}`),
    getContent: (id: string) => this.request("GET", `/campaigns/${id}/content`),
    setContent: (id: string, b: Json) => this.request("PUT", `/campaigns/${id}/content`, b),
    getSendChecklist: (id: string) => this.request("GET", `/campaigns/${id}/send-checklist`),
    send: (id: string) => this.request("POST", `/campaigns/${id}/actions/send`),
    schedule: (id: string, b: Json) => this.request("POST", `/campaigns/${id}/actions/schedule`, b),
    unschedule: (id: string) => this.request("POST", `/campaigns/${id}/actions/unschedule`),
    pause: (id: string) => this.request("POST", `/campaigns/${id}/actions/pause`),
    resume: (id: string) => this.request("POST", `/campaigns/${id}/actions/resume`),
    cancelSend: (id: string) => this.request("POST", `/campaigns/${id}/actions/cancel-send`),
    sendTestEmail: (id: string, b: Json) => this.request("POST", `/campaigns/${id}/actions/test`, b),
    replicate: (id: string) => this.request("POST", `/campaigns/${id}/actions/replicate`),
    createResend: (id: string) => this.request("POST", `/campaigns/${id}/actions/create-resend`),
    getFeedback: (id: string) => this.request("GET", `/campaigns/${id}/feedback`),
    addFeedback: (id: string, b: Json) => this.request("POST", `/campaigns/${id}/feedback`, b),
    getFeedbackMessage: (id: string, fid: string) => this.request("GET", `/campaigns/${id}/feedback/${fid}`),
    updateFeedbackMessage: (id: string, fid: string, b: Json) => this.request("PATCH", `/campaigns/${id}/feedback/${fid}`, b),
    deleteFeedbackMessage: (id: string, fid: string) => this.request("DELETE", `/campaigns/${id}/feedback/${fid}`),
  };

  campaignFolders = {
    list: () => this.request("GET", "/campaign-folders"),
    create: (b: Json) => this.request("POST", "/campaign-folders", b),
    get: (id: string) => this.request("GET", `/campaign-folders/${id}`),
    update: (id: string, b: Json) => this.request("PATCH", `/campaign-folders/${id}`, b),
    remove: (id: string) => this.request("DELETE", `/campaign-folders/${id}`),
  };

  templates = {
    list: () => this.request("GET", "/templates"),
    create: (b: Json) => this.request("POST", "/templates", b),
    getTemplate: (id: string) => this.request("GET", `/templates/${id}`),
    updateTemplate: (id: string, b: Json) => this.request("PATCH", `/templates/${id}`, b),
    deleteTemplate: (id: string) => this.request("DELETE", `/templates/${id}`),
    getDefaultContentForTemplate: (id: string) => this.request("GET", `/templates/${id}/default-content`),
  };

  templateFolders = {
    list: () => this.request("GET", "/template-folders"),
    create: (b: Json) => this.request("POST", "/template-folders", b),
    get: (id: string) => this.request("GET", `/template-folders/${id}`),
    update: (id: string, b: Json) => this.request("PATCH", `/template-folders/${id}`, b),
    remove: (id: string) => this.request("DELETE", `/template-folders/${id}`),
  };

  reports = {
    getAllCampaignReports: () => this.request("GET", "/reports"),
    getCampaignReport: (id: string) => this.request("GET", `/reports/${id}`),
    getCampaignClickDetails: (id: string) => this.request("GET", `/reports/${id}/click-details`),
    getEmailActivityForCampaign: (id: string) => this.request("GET", `/reports/${id}/email-activity`),
    getCampaignOpenDetails: (id: string) => this.request("GET", `/reports/${id}/open-details`),
    getUnsubscribedListForCampaign: (id: string) => this.request("GET", `/reports/${id}/unsubscribed`),
  };

  ecommerce = {
    stores: () => this.request("GET", "/ecommerce/stores"),
    addStore: (b: Json) => this.request("POST", "/ecommerce/stores", b),
    getStore: (id: string) => this.request("GET", `/ecommerce/stores/${id}`),
    updateStore: (id: string, b: Json) => this.request("PATCH", `/ecommerce/stores/${id}`, b),
    deleteStore: (id: string) => this.request("DELETE", `/ecommerce/stores/${id}`),
    orders: () => this.request("GET", "/ecommerce/orders"),

    getAllStoreProducts: (id: string) => this.request("GET", `/ecommerce/stores/${id}/products`),
    addStoreProduct: (id: string, b: Json) => this.request("POST", `/ecommerce/stores/${id}/products`, b),
    getStoreProduct: (id: string, pid: string) => this.request("GET", `/ecommerce/stores/${id}/products/${pid}`),
    updateStoreProduct: (id: string, pid: string, b: Json) => this.request("PATCH", `/ecommerce/stores/${id}/products/${pid}`, b),
    deleteStoreProduct: (id: string, pid: string) => this.request("DELETE", `/ecommerce/stores/${id}/products/${pid}`),

    getAllStoreCustomers: (id: string) => this.request("GET", `/ecommerce/stores/${id}/customers`),
    addStoreCustomer: (id: string, b: Json) => this.request("POST", `/ecommerce/stores/${id}/customers`, b),
    getStoreCustomer: (id: string, cid: string) => this.request("GET", `/ecommerce/stores/${id}/customers/${cid}`),
    setStoreCustomer: (id: string, cid: string, b: Json) => this.request("PUT", `/ecommerce/stores/${id}/customers/${cid}`, b),
    deleteStoreCustomer: (id: string, cid: string) => this.request("DELETE", `/ecommerce/stores/${id}/customers/${cid}`),

    getStoreOrders: (id: string) => this.request("GET", `/ecommerce/stores/${id}/orders`),
    addStoreOrder: (id: string, b: Json) => this.request("POST", `/ecommerce/stores/${id}/orders`, b),
    getOrder: (id: string, oid: string) => this.request("GET", `/ecommerce/stores/${id}/orders/${oid}`),
    deleteOrder: (id: string, oid: string) => this.request("DELETE", `/ecommerce/stores/${id}/orders/${oid}`),

    getStoreCarts: (id: string) => this.request("GET", `/ecommerce/stores/${id}/carts`),
    addStoreCart: (id: string, b: Json) => this.request("POST", `/ecommerce/stores/${id}/carts`, b),
    getStoreCart: (id: string, cid: string) => this.request("GET", `/ecommerce/stores/${id}/carts/${cid}`),
    deleteStoreCart: (id: string, cid: string) => this.request("DELETE", `/ecommerce/stores/${id}/carts/${cid}`),
    getAllCartLineItems: (id: string, cid: string) => this.request("GET", `/ecommerce/stores/${id}/carts/${cid}/lines`),
    addCartLineItem: (id: string, cid: string, b: Json) => this.request("POST", `/ecommerce/stores/${id}/carts/${cid}/lines`, b),
  };

  fileManager = {
    files: () => this.request("GET", "/file-manager/files"),
    upload: (b: Json) => this.request("POST", "/file-manager/files", b),
    getFile: (id: string) => this.request("GET", `/file-manager/files/${id}`),
    updateFile: (id: string, b: Json) => this.request("PATCH", `/file-manager/files/${id}`, b),
    deleteFile: (id: string) => this.request("DELETE", `/file-manager/files/${id}`),
    listFolders: () => this.request("GET", "/file-manager/folders"),
    createFolder: (b: Json) => this.request("POST", "/file-manager/folders", b),
    getFolder: (id: string) => this.request("GET", `/file-manager/folders/${id}`),
    updateFolder: (id: string, b: Json) => this.request("PATCH", `/file-manager/folders/${id}`, b),
    deleteFolder: (id: string) => this.request("DELETE", `/file-manager/folders/${id}`),
  };

  verifiedDomains = {
    getVerifiedDomainsAll: () => this.request("GET", "/verified-domains"),
    createVerifiedDomain: (b: Json) => this.request("POST", "/verified-domains", b),
    getDomain: (name: string) => this.request("GET", `/verified-domains/${name}`),
    submitDomainVerification: (name: string, b: Json = {}) => this.request("POST", `/verified-domains/${name}/actions/verify`, b),
    deleteDomain: (name: string) => this.request("DELETE", `/verified-domains/${name}`),
  };

  batches = {
    list: () => this.request("GET", "/batches"),
    start: (b: Json) => this.request("POST", "/batches", b),
    status: (id: string) => this.request("GET", `/batches/${id}`),
    deleteRequest: (id: string) => this.request("DELETE", `/batches/${id}`),
  };
}

function newListBody(name = "Parlel Newsletter"): Json {
  return {
    name,
    permission_reminder: "You signed up at parlel.test",
    email_type_option: true,
    contact: { company: "parlel", address1: "1 Test St", city: "Testville", state: "CA", zip: "00000", country: "US" },
    campaign_defaults: { from_name: "parlel", from_email: "hello@parlel.test", subject: "", language: "en" },
  };
}

describe("Mailchimp Service", () => {
  let server: MailchimpServer;
  let client: MailchimpClientSim;

  beforeAll(async () => {
    server = new MailchimpServer(PORT);
    await server.start();
    client = new MailchimpClientSim(API_KEY);
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function makeList(name?: string): Promise<string> {
    const l = await client.lists.createList(newListBody(name));
    return l.id;
  }

  async function makeMember(listId: string, email = "subscriber@parlel.test"): Promise<string> {
    await client.lists.addListMember(listId, { email_address: email, status: "subscribed", merge_fields: { FNAME: "Test", LNAME: "User" } });
    return subscriberHash(email);
  }

  async function makeSentCampaign(): Promise<string> {
    const c = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", from_name: "parlel", reply_to: "r@parlel.test", title: "T" } });
    await client.campaigns.send(c.id);
    return c.id;
  }

  // =========================================================================
  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns health JSON without auth", async () => {
      const health = await api("GET", "/health", undefined, {});
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/3.0/lists`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("has resettable ephemeral state", async () => {
      await makeList();
      expect(server.lists.size).toBe(1);
      server.reset();
      expect(server.lists.size).toBe(0);
    });

    it("exposes parlel control/state endpoints", async () => {
      await makeList();
      const state = await api("GET", "/__parlel/state");
      expect(state.status).toBe(200);
      expect(state.body.lists).toBe(1);
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.body.ok).toBe(true);
      expect(server.lists.size).toBe(0);
    });
  });

  // =========================================================================
  describe("Authentication", () => {
    it("rejects missing authorization with Mailchimp 401 shape", async () => {
      const response = await fetch(`${BASE_URL}/3.0/lists`, { method: "GET" });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.status).toBe(401);
      expect(body.title).toBe("API Key Invalid");
    });

    it("accepts Basic auth", async () => {
      const r = await api("GET", "/3.0/lists");
      expect(r.status).toBe(200);
    });

    it("accepts OAuth2 Bearer auth", async () => {
      const r = await api("GET", "/3.0/lists", undefined, { Authorization: "Bearer some-oauth-token" });
      expect(r.status).toBe(200);
    });
  });

  // =========================================================================
  describe("Root + Ping", () => {
    it("getRoot returns account info", async () => {
      const root = await client.root.getRoot();
      expect(root.account_id).toBeDefined();
      expect(root.account_name).toContain("Parlel");
    });

    it("ping returns the Chimpy health string", async () => {
      const pong = await client.ping.get();
      expect(pong.health_status).toBe("Everything's Chimpy!");
    });
  });

  // =========================================================================
  describe("Lists / Audiences CRUD", () => {
    it("creates, gets, lists, updates, and deletes a list", async () => {
      const created = await client.lists.createList(newListBody());
      expect(created.id).toBeDefined();
      expect(created.name).toBe("Parlel Newsletter");
      expect(created.stats.member_count).toBe(0);

      const got = await client.lists.getList(created.id);
      expect(got.id).toBe(created.id);

      const all = await client.lists.getAllLists();
      expect(all.total_items).toBe(1);
      expect(all.lists[0].id).toBe(created.id);

      const updated = await client.lists.updateList(created.id, { name: "Renamed" });
      expect(updated.name).toBe("Renamed");

      await client.lists.deleteList(created.id);
      const after = await client.lists.getAllLists();
      expect(after.total_items).toBe(0);
    });

    it("rejects a list with no name (400 Invalid Resource)", async () => {
      await expect(client.lists.createList({})).rejects.toMatchObject({ status: 400 });
    });

    it("returns 404 for a missing list", async () => {
      await expect(client.lists.getList("nope")).rejects.toMatchObject({ status: 404 });
    });

    it("supports offset/count pagination", async () => {
      await makeList("A");
      await makeList("B");
      await makeList("C");
      const page = await client.lists.getAllLists({ offset: 1, count: 1 });
      expect(page.total_items).toBe(3);
      expect(page.lists.length).toBe(1);
    });
  });

  // =========================================================================
  describe("Members", () => {
    it("adds, gets, updates, sets, and archives a member", async () => {
      const listId = await makeList();
      const added = await client.lists.addListMember(listId, {
        email_address: "a@parlel.test",
        status: "subscribed",
        merge_fields: { FNAME: "Ada", LNAME: "Lovelace" },
      });
      expect(added.id).toBe(subscriberHash("a@parlel.test"));
      expect(added.full_name).toBe("Ada Lovelace");
      expect(added.status).toBe("subscribed");

      const hash = subscriberHash("a@parlel.test");
      const got = await client.lists.getListMember(listId, hash);
      expect(got.email_address).toBe("a@parlel.test");

      const patched = await client.lists.updateListMember(listId, hash, { status: "unsubscribed" });
      expect(patched.status).toBe("unsubscribed");

      const set = await client.lists.setListMember(listId, hash, { email_address: "a@parlel.test", status: "subscribed" });
      expect(set.status).toBe("subscribed");

      const info = await client.lists.getListMembersInfo(listId);
      expect(info.total_items).toBe(1);

      await client.lists.deleteListMember(listId, hash);
      await expect(client.lists.getListMember(listId, hash)).rejects.toMatchObject({ status: 404 });
    });

    it("setListMember upserts a brand-new member via status_if_new", async () => {
      const listId = await makeList();
      const hash = subscriberHash("upsert@parlel.test");
      const set = await client.lists.setListMember(listId, hash, { email_address: "upsert@parlel.test", status_if_new: "subscribed", status: "subscribed" });
      expect(set.email_address).toBe("upsert@parlel.test");
    });

    it("rejects duplicate member with Member Exists", async () => {
      const listId = await makeList();
      await client.lists.addListMember(listId, { email_address: "dup@parlel.test", status: "subscribed" });
      await expect(
        client.lists.addListMember(listId, { email_address: "dup@parlel.test", status: "subscribed" }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("rejects an invalid email address", async () => {
      const listId = await makeList();
      await expect(client.lists.addListMember(listId, { email_address: "notanemail", status: "subscribed" })).rejects.toMatchObject({ status: 400 });
    });

    it("rejects an invalid status", async () => {
      const listId = await makeList();
      await expect(client.lists.addListMember(listId, { email_address: "x@parlel.test", status: "weird" })).rejects.toMatchObject({ status: 400 });
    });

    it("permanently deletes a member", async () => {
      const listId = await makeList();
      const hash = await makeMember(listId, "perm@parlel.test");
      await client.lists.deleteListMemberPermanent(listId, hash);
      await expect(client.lists.getListMember(listId, hash)).rejects.toMatchObject({ status: 404 });
    });

    it("filters members by status", async () => {
      const listId = await makeList();
      await client.lists.addListMember(listId, { email_address: "sub@parlel.test", status: "subscribed" });
      await client.lists.addListMember(listId, { email_address: "unsub@parlel.test", status: "unsubscribed" });
      const subs = await client.lists.getListMembersInfo(listId, { status: "subscribed" });
      expect(subs.total_items).toBe(1);
      expect(subs.members[0].email_address).toBe("sub@parlel.test");
    });
  });

  // =========================================================================
  describe("Member tags", () => {
    it("adds and removes tags", async () => {
      const listId = await makeList();
      const hash = await makeMember(listId, "tagged@parlel.test");
      await client.lists.updateListMemberTags(listId, hash, { tags: [{ name: "vip", status: "active" }, { name: "lead", status: "active" }] });
      let tags = await client.lists.getListMemberTags(listId, hash);
      expect(tags.total_items).toBe(2);
      await client.lists.updateListMemberTags(listId, hash, { tags: [{ name: "vip", status: "inactive" }] });
      tags = await client.lists.getListMemberTags(listId, hash);
      expect(tags.total_items).toBe(1);
      expect(tags.tags[0].name).toBe("lead");
    });
  });

  // =========================================================================
  describe("Member notes", () => {
    it("CRUD notes for a member", async () => {
      const listId = await makeList();
      const hash = await makeMember(listId, "noted@parlel.test");
      const note = await client.lists.createListMemberNote(listId, hash, { note: "Called them" });
      expect(note.note).toBe("Called them");
      const got = await client.lists.getListMemberNote(listId, hash, note.id);
      expect(got.id).toBe(note.id);
      const updated = await client.lists.updateListMemberNote(listId, hash, note.id, { note: "Followed up" });
      expect(updated.note).toBe("Followed up");
      const list = await client.lists.getListMemberNotes(listId, hash);
      expect(list.total_items).toBe(1);
      await client.lists.deleteListMemberNote(listId, hash, note.id);
      const after = await client.lists.getListMemberNotes(listId, hash);
      expect(after.total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Merge fields", () => {
    it("CRUD merge fields", async () => {
      const listId = await makeList();
      const field = await client.lists.addListMergeField(listId, { name: "Birthday", type: "date" });
      expect(field.merge_id).toBeDefined();
      expect(field.tag).toBeDefined();
      const got = await client.lists.getListMergeField(listId, String(field.merge_id));
      expect(got.name).toBe("Birthday");
      const updated = await client.lists.updateListMergeField(listId, String(field.merge_id), { name: "DOB", required: true });
      expect(updated.name).toBe("DOB");
      expect(updated.required).toBe(true);
      const all = await client.lists.getListMergeFields(listId);
      expect(all.total_items).toBe(1);
      await client.lists.deleteListMergeField(listId, String(field.merge_id));
      const after = await client.lists.getListMergeFields(listId);
      expect(after.total_items).toBe(0);
    });

    it("rejects a merge field without name/type", async () => {
      const listId = await makeList();
      await expect(client.lists.addListMergeField(listId, { name: "X" })).rejects.toMatchObject({ status: 400 });
    });
  });

  // =========================================================================
  describe("Segments", () => {
    it("CRUD segments and batch members", async () => {
      const listId = await makeList();
      await client.lists.addListMember(listId, { email_address: "seg1@parlel.test", status: "subscribed" });
      await client.lists.addListMember(listId, { email_address: "seg2@parlel.test", status: "subscribed" });

      const seg = await client.lists.createSegment(listId, { name: "VIPs", static_segment: ["seg1@parlel.test"] });
      expect(seg.id).toBeDefined();
      expect(seg.member_count).toBe(1);

      const got = await client.lists.getSegment(listId, String(seg.id));
      expect(got.name).toBe("VIPs");

      const updated = await client.lists.updateSegment(listId, String(seg.id), { name: "Top VIPs" });
      expect(updated.name).toBe("Top VIPs");

      const batch = await client.lists.batchSegmentMembers(
        { members_to_add: ["seg2@parlel.test"], members_to_remove: ["seg1@parlel.test"] },
        listId,
        String(seg.id),
      );
      expect(batch.total_added).toBe(1);
      expect(batch.total_removed).toBe(1);

      const members = await client.lists.getSegmentMembersList(listId, String(seg.id));
      expect(members.total_items).toBe(1);
      expect(members.members[0].email_address).toBe("seg2@parlel.test");

      const list = await client.lists.listSegments(listId);
      expect(list.total_items).toBe(1);

      await client.lists.deleteSegment(listId, String(seg.id));
      const after = await client.lists.listSegments(listId);
      expect(after.total_items).toBe(0);
    });

    it("adds and removes a single segment member", async () => {
      const listId = await makeList();
      await client.lists.addListMember(listId, { email_address: "m@parlel.test", status: "subscribed" });
      const seg = await client.lists.createSegment(listId, { name: "S", static_segment: [] });
      await client.lists.createSegmentMember(listId, String(seg.id), { email_address: "m@parlel.test" });
      let mem = await client.lists.getSegmentMembersList(listId, String(seg.id));
      expect(mem.total_items).toBe(1);
      await client.lists.removeSegmentMember(listId, String(seg.id), subscriberHash("m@parlel.test"));
      mem = await client.lists.getSegmentMembersList(listId, String(seg.id));
      expect(mem.total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Interest categories + interests", () => {
    it("CRUD categories and interests", async () => {
      const listId = await makeList();
      const cat = await client.lists.createListInterestCategory(listId, { title: "Topics", type: "checkboxes" });
      expect(cat.id).toBeDefined();
      const gotCat = await client.lists.getInterestCategory(listId, cat.id);
      expect(gotCat.title).toBe("Topics");
      const updatedCat = await client.lists.updateInterestCategory(listId, cat.id, { title: "Subjects" });
      expect(updatedCat.title).toBe("Subjects");

      const interest = await client.lists.createInterestCategoryInterest(listId, cat.id, { name: "News" });
      expect(interest.id).toBeDefined();
      const gotInt = await client.lists.getInterestCategoryInterest(listId, cat.id, interest.id);
      expect(gotInt.name).toBe("News");
      const updatedInt = await client.lists.updateInterestCategoryInterest(listId, cat.id, interest.id, { name: "Updates" });
      expect(updatedInt.name).toBe("Updates");
      const ints = await client.lists.listInterestCategoryInterests(listId, cat.id);
      expect(ints.total_items).toBe(1);

      await client.lists.deleteInterestCategoryInterest(listId, cat.id, interest.id);
      const afterInts = await client.lists.listInterestCategoryInterests(listId, cat.id);
      expect(afterInts.total_items).toBe(0);

      const cats = await client.lists.getListInterestCategories(listId);
      expect(cats.total_items).toBe(1);
      await client.lists.deleteInterestCategory(listId, cat.id);
      const afterCats = await client.lists.getListInterestCategories(listId);
      expect(afterCats.total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Webhooks", () => {
    it("CRUD webhooks", async () => {
      const listId = await makeList();
      const wh = await client.lists.createListWebhook(listId, { url: "https://hook.parlel.test/mc", events: { subscribe: true } });
      expect(wh.id).toBeDefined();
      const got = await client.lists.getListWebhook(listId, wh.id);
      expect(got.url).toBe("https://hook.parlel.test/mc");
      const updated = await client.lists.updateListWebhook(listId, wh.id, { url: "https://hook2.parlel.test" });
      expect(updated.url).toBe("https://hook2.parlel.test");
      const all = await client.lists.getListWebhooks(listId);
      expect(all.total_items).toBe(1);
      await client.lists.deleteListWebhook(listId, wh.id);
      const after = await client.lists.getListWebhooks(listId);
      expect(after.total_items).toBe(0);
    });

    it("rejects a webhook without url", async () => {
      const listId = await makeList();
      await expect(client.lists.createListWebhook(listId, {})).rejects.toMatchObject({ status: 400 });
    });
  });

  // =========================================================================
  describe("List read-only sub-resources", () => {
    it("returns growth history, activity, clients, locations, tag-search", async () => {
      const listId = await makeList();
      expect((await client.lists.getListGrowthHistory(listId)).history).toEqual([]);
      expect((await client.lists.getListActivity(listId)).activity).toEqual([]);
      expect((await client.lists.getListClients(listId)).clients).toEqual([]);
      expect((await client.lists.getListLocations(listId)).locations).toEqual([]);
      expect((await client.lists.tagSearch(listId, { name: "x" })).tags).toEqual([]);
    });
  });

  // =========================================================================
  describe("Batch list members", () => {
    it("upserts many members at once", async () => {
      const listId = await makeList();
      const res = await client.lists.batchListMembers(listId, {
        members: [
          { email_address: "b1@parlel.test", status: "subscribed" },
          { email_address: "b2@parlel.test", status: "subscribed" },
          { email_address: "bad", status: "subscribed" },
        ],
      });
      expect(res.total_created).toBe(2);
      expect(res.error_count).toBe(1);
    });
  });

  // =========================================================================
  describe("Campaigns", () => {
    it("creates, gets, lists, updates, and deletes a campaign", async () => {
      const created = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "Test" } });
      expect(created.id).toBeDefined();
      expect(created.status).toBe("save");

      const got = await client.campaigns.get(created.id);
      expect(got.id).toBe(created.id);

      const list = await client.campaigns.list();
      expect(list.total_items).toBe(1);

      const updated = await client.campaigns.update(created.id, { settings: { title: "Renamed" } });
      expect(updated.settings.title).toBe("Renamed");

      await client.campaigns.remove(created.id);
      const after = await client.campaigns.list();
      expect(after.total_items).toBe(0);
    });

    it("rejects an invalid campaign type", async () => {
      await expect(client.campaigns.create({ type: "bogus" })).rejects.toMatchObject({ status: 400 });
    });

    it("sets and gets campaign content", async () => {
      const c = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "T" } });
      const set = await client.campaigns.setContent(c.id, { html: "<h1>Hello</h1>", plain_text: "Hello" });
      expect(set.html).toBe("<h1>Hello</h1>");
      const got = await client.campaigns.getContent(c.id);
      expect(got.plain_text).toBe("Hello");
    });

    it("runs send / schedule / unschedule / pause / resume / cancel actions", async () => {
      const c = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "T" } });
      await client.campaigns.send(c.id);
      expect((await client.campaigns.get(c.id)).status).toBe("sent");

      const c2 = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "T" } });
      await client.campaigns.schedule(c2.id, { schedule_time: "2030-01-01T00:00:00+00:00" });
      expect((await client.campaigns.get(c2.id)).status).toBe("schedule");
      await client.campaigns.unschedule(c2.id);
      expect((await client.campaigns.get(c2.id)).status).toBe("save");

      const c3 = await client.campaigns.create({ type: "rss", settings: { subject_line: "Hi", title: "T" } });
      await client.campaigns.pause(c3.id);
      expect((await client.campaigns.get(c3.id)).status).toBe("paused");
      await client.campaigns.resume(c3.id);
      expect((await client.campaigns.get(c3.id)).status).toBe("sending");
    });

    it("sends a test email and gets the send checklist", async () => {
      const c = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "T" } });
      await expect(client.campaigns.sendTestEmail(c.id, { test_emails: ["t@parlel.test"], send_type: "html" })).resolves.toBeNull();
      const checklist = await client.campaigns.getSendChecklist(c.id);
      expect(checklist.is_ready).toBe(true);
    });

    it("replicates and resends a campaign", async () => {
      const c = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "T" } });
      const replica = await client.campaigns.replicate(c.id);
      expect(replica.id).not.toBe(c.id);
      const resend = await client.campaigns.createResend(c.id);
      expect(resend.id).toBeDefined();
      expect((await client.campaigns.list()).total_items).toBe(3);
    });

    it("CRUD campaign feedback", async () => {
      const c = await client.campaigns.create({ type: "regular", settings: { subject_line: "Hi", title: "T" } });
      const fb = await client.campaigns.addFeedback(c.id, { message: "Looks good" });
      expect(fb.message).toBe("Looks good");
      const got = await client.campaigns.getFeedbackMessage(c.id, String(fb.feedback_id));
      expect(got.message).toBe("Looks good");
      const updated = await client.campaigns.updateFeedbackMessage(c.id, String(fb.feedback_id), { message: "Edited" });
      expect(updated.message).toBe("Edited");
      const list = await client.campaigns.getFeedback(c.id);
      expect(list.total_items).toBe(1);
      await client.campaigns.deleteFeedbackMessage(c.id, String(fb.feedback_id));
      expect((await client.campaigns.getFeedback(c.id)).total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Campaign folders", () => {
    it("CRUD campaign folders", async () => {
      const f = await client.campaignFolders.create({ name: "Q1" });
      expect(f.id).toBeDefined();
      const got = await client.campaignFolders.get(f.id);
      expect(got.name).toBe("Q1");
      const updated = await client.campaignFolders.update(f.id, { name: "Q2" });
      expect(updated.name).toBe("Q2");
      const list = await client.campaignFolders.list();
      expect(list.total_items).toBe(1);
      await client.campaignFolders.remove(f.id);
      expect((await client.campaignFolders.list()).total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Templates + template folders", () => {
    it("CRUD templates", async () => {
      const t = await client.templates.create({ name: "Welcome", html: "<p>Hi</p>" });
      expect(t.id).toBeDefined();
      expect(t.name).toBe("Welcome");
      const got = await client.templates.getTemplate(String(t.id));
      expect(got.name).toBe("Welcome");
      const updated = await client.templates.updateTemplate(String(t.id), { name: "Welcome 2" });
      expect(updated.name).toBe("Welcome 2");
      const dc = await client.templates.getDefaultContentForTemplate(String(t.id));
      expect(dc.sections).toBeDefined();
      const list = await client.templates.list();
      expect(list.total_items).toBe(1);
      await client.templates.deleteTemplate(String(t.id));
      expect((await client.templates.list()).total_items).toBe(0);
    });

    it("CRUD template folders", async () => {
      const f = await client.templateFolders.create({ name: "Layouts" });
      expect(f.id).toBeDefined();
      const updated = await client.templateFolders.update(f.id, { name: "Designs" });
      expect(updated.name).toBe("Designs");
      expect((await client.templateFolders.list()).total_items).toBe(1);
      await client.templateFolders.remove(f.id);
      expect((await client.templateFolders.list()).total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Reports (read-only)", () => {
    it("lists reports for sent campaigns and reads one", async () => {
      const id = await makeSentCampaign();
      const all = await client.reports.getAllCampaignReports();
      expect(all.total_items).toBe(1);
      const report = await client.reports.getCampaignReport(id);
      expect(report.id).toBe(id);
      expect(report.opens).toBeDefined();
      expect(report.clicks).toBeDefined();
    });

    it("returns sub-report endpoints", async () => {
      const id = await makeSentCampaign();
      expect((await client.reports.getCampaignClickDetails(id)).urls_clicked).toEqual([]);
      expect((await client.reports.getEmailActivityForCampaign(id)).emails).toEqual([]);
      expect((await client.reports.getCampaignOpenDetails(id)).members).toEqual([]);
      expect((await client.reports.getUnsubscribedListForCampaign(id)).unsubscribes).toEqual([]);
    });

    it("404 for an unknown report", async () => {
      await expect(client.reports.getCampaignReport("nope")).rejects.toMatchObject({ status: 404 });
    });
  });

  // =========================================================================
  describe("E-commerce", () => {
    async function makeStore(): Promise<string> {
      const store = await client.ecommerce.addStore({ id: "store1", list_id: "anylist", name: "parlel Shop", currency_code: "USD" });
      return store.id;
    }

    it("CRUD stores", async () => {
      const id = await makeStore();
      const got = await client.ecommerce.getStore(id);
      expect(got.name).toBe("parlel Shop");
      const updated = await client.ecommerce.updateStore(id, { name: "parlel Store" });
      expect(updated.name).toBe("parlel Store");
      const list = await client.ecommerce.stores();
      expect(list.total_items).toBe(1);
      await client.ecommerce.deleteStore(id);
      expect((await client.ecommerce.stores()).total_items).toBe(0);
    });

    it("rejects a store missing required fields", async () => {
      await expect(client.ecommerce.addStore({ name: "x" })).rejects.toMatchObject({ status: 400 });
    });

    it("CRUD products", async () => {
      const id = await makeStore();
      const p = await client.ecommerce.addStoreProduct(id, { id: "p1", title: "Widget", variants: [{ id: "v1", title: "Default" }] });
      expect(p.id).toBe("p1");
      const got = await client.ecommerce.getStoreProduct(id, "p1");
      expect(got.title).toBe("Widget");
      const updated = await client.ecommerce.updateStoreProduct(id, "p1", { title: "Gadget" });
      expect(updated.title).toBe("Gadget");
      expect((await client.ecommerce.getAllStoreProducts(id)).total_items).toBe(1);
      await client.ecommerce.deleteStoreProduct(id, "p1");
      expect((await client.ecommerce.getAllStoreProducts(id)).total_items).toBe(0);
    });

    it("CRUD customers with PUT upsert", async () => {
      const id = await makeStore();
      const c = await client.ecommerce.addStoreCustomer(id, { id: "c1", email_address: "buyer@parlel.test", opt_in_status: false });
      expect(c.id).toBe("c1");
      const set = await client.ecommerce.setStoreCustomer(id, "c1", { id: "c1", email_address: "buyer@parlel.test", opt_in_status: true });
      expect(set.opt_in_status).toBe(true);
      expect((await client.ecommerce.getAllStoreCustomers(id)).total_items).toBe(1);
      await client.ecommerce.deleteStoreCustomer(id, "c1");
      expect((await client.ecommerce.getAllStoreCustomers(id)).total_items).toBe(0);
    });

    it("CRUD orders and account-wide order listing", async () => {
      const id = await makeStore();
      const o = await client.ecommerce.addStoreOrder(id, {
        id: "o1",
        customer: { id: "c1", email_address: "buyer@parlel.test", opt_in_status: false },
        currency_code: "USD",
        order_total: 9.99,
        lines: [{ id: "l1", product_id: "p1", product_variant_id: "v1", quantity: 1, price: 9.99 }],
      });
      expect(o.id).toBe("o1");
      const got = await client.ecommerce.getOrder(id, "o1");
      expect(got.order_total).toBe(9.99);
      expect((await client.ecommerce.getStoreOrders(id)).total_items).toBe(1);
      expect((await client.ecommerce.orders()).total_items).toBe(1);
      await client.ecommerce.deleteOrder(id, "o1");
      expect((await client.ecommerce.getStoreOrders(id)).total_items).toBe(0);
    });

    it("CRUD carts and cart lines", async () => {
      const id = await makeStore();
      const cart = await client.ecommerce.addStoreCart(id, {
        id: "cart1",
        customer: { id: "c1", email_address: "buyer@parlel.test", opt_in_status: false },
        currency_code: "USD",
        order_total: 5,
        lines: [{ id: "l1", product_id: "p1", product_variant_id: "v1", quantity: 1, price: 5 }],
      });
      expect(cart.id).toBe("cart1");
      const lines = await client.ecommerce.getAllCartLineItems(id, "cart1");
      expect(lines.total_items).toBe(1);
      const added = await client.ecommerce.addCartLineItem(id, "cart1", { id: "l2", product_id: "p2", product_variant_id: "v2", quantity: 2, price: 3 });
      expect(added.id).toBe("l2");
      expect((await client.ecommerce.getAllCartLineItems(id, "cart1")).total_items).toBe(2);
      await client.ecommerce.deleteStoreCart(id, "cart1");
      expect((await client.ecommerce.getStoreCarts(id)).total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("File Manager", () => {
    it("CRUD files", async () => {
      const f = await client.fileManager.upload({ name: "logo.png", file_data: "aGVsbG8=" });
      expect(f.id).toBeDefined();
      const got = await client.fileManager.getFile(String(f.id));
      expect(got.name).toBe("logo.png");
      const updated = await client.fileManager.updateFile(String(f.id), { name: "brand.png" });
      expect(updated.name).toBe("brand.png");
      expect((await client.fileManager.files()).total_items).toBe(1);
      await client.fileManager.deleteFile(String(f.id));
      expect((await client.fileManager.files()).total_items).toBe(0);
    });

    it("CRUD file folders", async () => {
      const folder = await client.fileManager.createFolder({ name: "Brand" });
      expect(folder.id).toBeDefined();
      const updated = await client.fileManager.updateFolder(String(folder.id), { name: "Branding" });
      expect(updated.name).toBe("Branding");
      expect((await client.fileManager.listFolders()).total_items).toBe(1);
      await client.fileManager.deleteFolder(String(folder.id));
      expect((await client.fileManager.listFolders()).total_items).toBe(0);
    });

    it("rejects a file with no data", async () => {
      await expect(client.fileManager.upload({ name: "x.png" })).rejects.toMatchObject({ status: 400 });
    });
  });

  // =========================================================================
  describe("Verified domains", () => {
    it("creates, gets, verifies, lists, deletes a domain", async () => {
      const created = await client.verifiedDomains.createVerifiedDomain({ verification_email: "postmaster@parlel.test" });
      expect(created.domain).toBe("parlel.test");
      expect(created.verified).toBe(false);
      const verified = await client.verifiedDomains.submitDomainVerification("parlel.test", { code: "123456" });
      expect(verified.verified).toBe(true);
      const got = await client.verifiedDomains.getDomain("parlel.test");
      expect(got.authenticated).toBe(true);
      expect((await client.verifiedDomains.getVerifiedDomainsAll()).total_items).toBe(1);
      await client.verifiedDomains.deleteDomain("parlel.test");
      expect((await client.verifiedDomains.getVerifiedDomainsAll()).total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Batch operations", () => {
    it("starts, reads status, lists, and deletes a batch", async () => {
      const batch = await client.batches.start({
        operations: [
          { method: "POST", path: "/lists/abc/members", body: JSON.stringify({ email_address: "x@parlel.test", status: "subscribed" }) },
        ],
      });
      expect(batch.id).toBeDefined();
      expect(batch.total_operations).toBe(1);
      const status = await client.batches.status(batch.id);
      expect(status.status).toBe("finished");
      expect((await client.batches.list()).total_items).toBe(1);
      await client.batches.deleteRequest(batch.id);
      expect((await client.batches.list()).total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Search", () => {
    it("searchMembers finds exact and partial matches", async () => {
      const listId = await makeList();
      await client.lists.addListMember(listId, { email_address: "alice@parlel.test", status: "subscribed" });
      await client.lists.addListMember(listId, { email_address: "alicia@parlel.test", status: "subscribed" });
      const exact = await client.searchMembers.search({ query: "alice@parlel.test" });
      expect(exact.exact_matches.total_items).toBe(1);
      const partial = await client.searchMembers.search({ query: "ali" });
      expect(partial.full_search.total_items).toBe(2);
    });

    it("searchCampaigns returns an empty result set", async () => {
      const res = await client.searchCampaigns.search({ query: "x" });
      expect(res.results.total_items).toBe(0);
    });
  });

  // =========================================================================
  describe("Error shapes + edge cases", () => {
    it("returns 404 problem+json for unknown endpoints", async () => {
      const r = await api("GET", "/3.0/does-not-exist");
      expect(r.status).toBe(404);
      expect(r.body.title).toBe("Resource Not Found");
      expect(r.body.status).toBe(404);
    });

    it("returns 400 for malformed JSON body", async () => {
      const r = await fetch(`${BASE_URL}/3.0/lists`, {
        method: "POST",
        headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(r.status).toBe(400);
    });

    it("returns 405 for unsupported methods on a resource", async () => {
      const r = await api("PUT", "/3.0/lists");
      expect(r.status).toBe(405);
      expect(r.body.title).toBe("Method Not Allowed");
    });

    it("works with and without the /3.0 prefix", async () => {
      const withPrefix = await api("GET", "/3.0/ping");
      const withoutPrefix = await api("GET", "/ping");
      expect(withPrefix.status).toBe(200);
      expect(withoutPrefix.status).toBe(200);
    });
  });
});
