import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ActivecampaignServer } from "../services/activecampaign/src/server.js";

const PORT = 14659;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_TOKEN = "parlel-test-api-token";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

const AUTH = { "Api-Token": API_TOKEN };

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
 * Faithful re-implementation of how application code drives the ActiveCampaign
 * v3 REST API with `axios`. The documented integration pattern is:
 *
 *   const ac = axios.create({
 *     baseURL: "https://<account>.api-us1.com/api/3",
 *     headers: { "Api-Token": apiToken, "Content-Type": "application/json" },
 *   });
 *   await ac.post("/contacts", { contact: { email, firstName } });
 *
 * This sim mirrors that exact request shape on the wire (singular-keyed
 * bodies, Api-Token header, plural-keyed list envelopes with meta.total),
 * exercising the precise protocol the real axios client speaks — with zero
 * external dependencies.
 */
class ActiveCampaignAxiosSim {
  constructor(private apiToken: string, private baseUrl = `${BASE_URL}/api/3`) {}

  private async request(method: string, path: string, data?: any) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Api-Token": this.apiToken,
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status: response.status, data: parsed };
  }

  // Contacts
  listContacts = (query = "") => this.request("GET", `/contacts${query}`);
  getContact = (id: string) => this.request("GET", `/contacts/${id}`);
  createContact = (contact: Json) => this.request("POST", "/contacts", { contact });
  updateContact = (id: string, contact: Json) => this.request("PUT", `/contacts/${id}`, { contact });
  deleteContact = (id: string) => this.request("DELETE", `/contacts/${id}`);
  syncContact = (contact: Json) => this.request("POST", "/contact/sync", { contact });
  contactTags = (id: string) => this.request("GET", `/contacts/${id}/contactTags`);
  contactLists = (id: string) => this.request("GET", `/contacts/${id}/contactLists`);
  contactFieldValues = (id: string) => this.request("GET", `/contacts/${id}/fieldValues`);

  // Tags
  listTags = () => this.request("GET", "/tags");
  getTag = (id: string) => this.request("GET", `/tags/${id}`);
  createTag = (tag: Json) => this.request("POST", "/tags", { tag });
  updateTag = (id: string, tag: Json) => this.request("PUT", `/tags/${id}`, { tag });
  deleteTag = (id: string) => this.request("DELETE", `/tags/${id}`);

  // ContactTags
  listContactTags = () => this.request("GET", "/contactTags");
  addTagToContact = (contact: string, tag: string) => this.request("POST", "/contactTags", { contactTag: { contact, tag } });
  removeContactTag = (id: string) => this.request("DELETE", `/contactTags/${id}`);

  // Lists
  listLists = () => this.request("GET", "/lists");
  getList = (id: string) => this.request("GET", `/lists/${id}`);
  createList = (list: Json) => this.request("POST", "/lists", { list });
  updateList = (id: string, list: Json) => this.request("PUT", `/lists/${id}`, { list });
  deleteList = (id: string) => this.request("DELETE", `/lists/${id}`);

  // ContactLists
  updateListStatus = (list: string, contact: string, status: string) =>
    this.request("POST", "/contactLists", { contactList: { list, contact, status } });

  // Custom Fields
  listFields = () => this.request("GET", "/fields");
  getField = (id: string) => this.request("GET", `/fields/${id}`);
  createField = (field: Json) => this.request("POST", "/fields", { field });
  updateField = (id: string, field: Json) => this.request("PUT", `/fields/${id}`, { field });
  deleteField = (id: string) => this.request("DELETE", `/fields/${id}`);

  // Field Values
  listFieldValues = () => this.request("GET", "/fieldValues");
  getFieldValue = (id: string) => this.request("GET", `/fieldValues/${id}`);
  setFieldValue = (contact: string, field: string, value: string) =>
    this.request("POST", "/fieldValues", { fieldValue: { contact, field, value } });
  updateFieldValue = (id: string, value: string) => this.request("PUT", `/fieldValues/${id}`, { fieldValue: { value } });
  deleteFieldValue = (id: string) => this.request("DELETE", `/fieldValues/${id}`);

  // Deals
  listDeals = () => this.request("GET", "/deals");
  getDeal = (id: string) => this.request("GET", `/deals/${id}`);
  createDeal = (deal: Json) => this.request("POST", "/deals", { deal });
  updateDeal = (id: string, deal: Json) => this.request("PUT", `/deals/${id}`, { deal });
  deleteDeal = (id: string) => this.request("DELETE", `/deals/${id}`);

  // Pipelines / Stages
  listDealGroups = () => this.request("GET", "/dealGroups");
  getDealGroup = (id: string) => this.request("GET", `/dealGroups/${id}`);
  createDealGroup = (dealGroup: Json) => this.request("POST", "/dealGroups", { dealGroup });
  updateDealGroup = (id: string, dealGroup: Json) => this.request("PUT", `/dealGroups/${id}`, { dealGroup });
  deleteDealGroup = (id: string) => this.request("DELETE", `/dealGroups/${id}`);
  listDealStages = () => this.request("GET", "/dealStages");
  getDealStage = (id: string) => this.request("GET", `/dealStages/${id}`);
  createDealStage = (dealStage: Json) => this.request("POST", "/dealStages", { dealStage });
  updateDealStage = (id: string, dealStage: Json) => this.request("PUT", `/dealStages/${id}`, { dealStage });
  deleteDealStage = (id: string) => this.request("DELETE", `/dealStages/${id}`);

  // Notes
  listNotes = () => this.request("GET", "/notes");
  getNote = (id: string) => this.request("GET", `/notes/${id}`);
  createNote = (note: Json) => this.request("POST", "/notes", { note });
  updateNote = (id: string, note: Json) => this.request("PUT", `/notes/${id}`, { note });
  deleteNote = (id: string) => this.request("DELETE", `/notes/${id}`);

  // Accounts
  listAccounts = () => this.request("GET", "/accounts");
  getAccount = (id: string) => this.request("GET", `/accounts/${id}`);
  createAccount = (account: Json) => this.request("POST", "/accounts", { account });
  updateAccount = (id: string, account: Json) => this.request("PUT", `/accounts/${id}`, { account });
  deleteAccount = (id: string) => this.request("DELETE", `/accounts/${id}`);

  // Campaigns / Automations / Segments / Users (read-only)
  listCampaigns = () => this.request("GET", "/campaigns");
  getCampaign = (id: string) => this.request("GET", `/campaigns/${id}`);
  listAutomations = () => this.request("GET", "/automations");
  getAutomation = (id: string) => this.request("GET", `/automations/${id}`);
  listSegments = () => this.request("GET", "/segments");
  getSegment = (id: string) => this.request("GET", `/segments/${id}`);
  listUsers = () => this.request("GET", "/users");
  getUser = (id: string) => this.request("GET", `/users/${id}`);

  // Contact Automations
  listContactAutomations = () => this.request("GET", "/contactAutomations");
  enrolContact = (contact: string, automation: string) =>
    this.request("POST", "/contactAutomations", { contactAutomation: { contact, automation } });
  getContactAutomation = (id: string) => this.request("GET", `/contactAutomations/${id}`);
  removeContactAutomation = (id: string) => this.request("DELETE", `/contactAutomations/${id}`);

  // Webhooks
  listWebhooks = () => this.request("GET", "/webhooks");
  getWebhook = (id: string) => this.request("GET", `/webhooks/${id}`);
  createWebhook = (webhook: Json) => this.request("POST", "/webhooks", { webhook });
  updateWebhook = (id: string, webhook: Json) => this.request("PUT", `/webhooks/${id}`, { webhook });
  deleteWebhook = (id: string) => this.request("DELETE", `/webhooks/${id}`);
}

let server: ActivecampaignServer;
let ac: ActiveCampaignAxiosSim;

beforeAll(async () => {
  server = new ActivecampaignServer(PORT);
  await server.start();
  ac = new ActiveCampaignAxiosSim(API_TOKEN);
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  await api("POST", "/__parlel/reset", undefined, {});
});

// helper to create a contact and return its id
async function makeContact(email: string, extra: Json = {}): Promise<string> {
  const res = await ac.createContact({ email, ...extra });
  return res.data.contact.id;
}

describe("infrastructure", () => {
  it("responds to health check without auth", async () => {
    const res = await api("GET", "/health", undefined, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects /api/3 requests without an Api-Token", async () => {
    const res = await api("GET", "/api/3/contacts", undefined, {});
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("message");
  });

  it("accepts Api-Token auth", async () => {
    const res = await ac.listContacts();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.contacts)).toBe(true);
    expect(res.data.meta).toHaveProperty("total");
  });

  it("returns 404 for unknown /api/3 resources", async () => {
    const res = await api("GET", "/api/3/nonexistent", undefined, AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("message");
  });

  it("returns 404 for non-/api/3 paths", async () => {
    const res = await api("GET", "/some/other/path", undefined, AUTH);
    expect(res.status).toBe(404);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await fetch(`${BASE_URL}/api/3/contacts`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
  });

  it("handles OPTIONS preflight with 204", async () => {
    const res = await api("OPTIONS", "/api/3/contacts", undefined, AUTH);
    expect(res.status).toBe(204);
  });

  it("reports state via /__parlel/state", async () => {
    const res = await api("GET", "/__parlel/state", undefined, {});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("contacts");
    expect(res.body).toHaveProperty("deals");
    expect(res.body).toHaveProperty("dealStages");
  });

  it("seeds a default pipeline, stages, user, campaign, automation, segment", async () => {
    const groups = await ac.listDealGroups();
    expect(Number(groups.data.meta.total)).toBeGreaterThanOrEqual(1);
    const stages = await ac.listDealStages();
    expect(Number(stages.data.meta.total)).toBeGreaterThanOrEqual(5);
    const users = await ac.listUsers();
    expect(Number(users.data.meta.total)).toBeGreaterThanOrEqual(1);
    const campaigns = await ac.listCampaigns();
    expect(Number(campaigns.data.meta.total)).toBeGreaterThanOrEqual(1);
    const automations = await ac.listAutomations();
    expect(Number(automations.data.meta.total)).toBeGreaterThanOrEqual(1);
    const segments = await ac.listSegments();
    expect(Number(segments.data.meta.total)).toBeGreaterThanOrEqual(1);
  });
});

describe("contacts", () => {
  it("creates a contact", async () => {
    const res = await ac.createContact({ email: "a@parlel.test", firstName: "Ada", lastName: "Lovelace", phone: "+15551234" });
    expect(res.status).toBe(201);
    expect(res.data.contact.email).toBe("a@parlel.test");
    expect(res.data.contact.firstName).toBe("Ada");
    expect(typeof res.data.contact.id).toBe("string");
    expect(res.data.contact.links).toHaveProperty("contactTags");
  });

  it("lists contacts with meta.total", async () => {
    await ac.createContact({ email: "x@parlel.test" });
    await ac.createContact({ email: "y@parlel.test" });
    const res = await ac.listContacts();
    expect(res.status).toBe(200);
    expect(res.data.contacts.length).toBe(2);
    expect(res.data.meta.total).toBe("2");
  });

  it("filters contacts by email", async () => {
    await ac.createContact({ email: "find@parlel.test" });
    await ac.createContact({ email: "other@parlel.test" });
    const res = await ac.listContacts("?email=find@parlel.test");
    expect(res.data.contacts.length).toBe(1);
    expect(res.data.contacts[0].email).toBe("find@parlel.test");
  });

  it("searches contacts by name", async () => {
    await ac.createContact({ email: "z@parlel.test", firstName: "Grace", lastName: "Hopper" });
    const res = await ac.listContacts("?search=hopper");
    expect(res.data.contacts.length).toBe(1);
  });

  it("paginates contacts", async () => {
    for (let i = 0; i < 5; i++) await ac.createContact({ email: `p${i}@parlel.test` });
    const res = await ac.listContacts("?limit=2&offset=2");
    expect(res.data.contacts.length).toBe(2);
    expect(res.data.meta.total).toBe("5");
  });

  it("gets a contact by id", async () => {
    const id = await makeContact("get@parlel.test");
    const res = await ac.getContact(id);
    expect(res.status).toBe(200);
    expect(res.data.contact.id).toBe(id);
  });

  it("updates a contact", async () => {
    const id = await makeContact("upd@parlel.test", { firstName: "Old" });
    const res = await ac.updateContact(id, { firstName: "New", lastName: "Name" });
    expect(res.status).toBe(200);
    expect(res.data.contact.firstName).toBe("New");
    expect(res.data.contact.lastName).toBe("Name");
  });

  it("deletes a contact", async () => {
    const id = await makeContact("del@parlel.test");
    const res = await ac.deleteContact(id);
    expect(res.status).toBe(200);
    const after = await ac.getContact(id);
    expect(after.status).toBe(404);
  });

  it("rejects creating a contact without an email (422)", async () => {
    const res = await ac.createContact({ firstName: "NoEmail" });
    expect(res.status).toBe(422);
    // Real AC v3 error envelope: { errors: [ { title, detail?, code? } ] } — no `source`.
    expect(res.data.errors[0]).toHaveProperty("title");
    expect(res.data.errors[0]).not.toHaveProperty("source");
  });

  it("rejects an invalid email (422)", async () => {
    const res = await ac.createContact({ email: "not-an-email" });
    expect(res.status).toBe(422);
  });

  it("rejects a duplicate email (422)", async () => {
    await ac.createContact({ email: "dup@parlel.test" });
    const res = await ac.createContact({ email: "dup@parlel.test" });
    expect(res.status).toBe(422);
    expect(res.data.errors[0].title).toMatch(/already exists/i);
  });

  it("rejects updating to an invalid email (422)", async () => {
    const id = await makeContact("v@parlel.test");
    const res = await ac.updateContact(id, { email: "bad" });
    expect(res.status).toBe(422);
  });

  it("rejects updating to a duplicate email (422)", async () => {
    await ac.createContact({ email: "one@parlel.test" });
    const id = await makeContact("two@parlel.test");
    const res = await ac.updateContact(id, { email: "one@parlel.test" });
    expect(res.status).toBe(422);
  });

  it("404s getting an unknown contact", async () => {
    const res = await ac.getContact("999999");
    expect(res.status).toBe(404);
  });

  it("404s updating an unknown contact", async () => {
    const res = await ac.updateContact("999999", { firstName: "x" });
    expect(res.status).toBe(404);
  });

  it("404s deleting an unknown contact", async () => {
    const res = await ac.deleteContact("999999");
    expect(res.status).toBe(404);
  });
});

describe("contact/sync (upsert)", () => {
  it("creates a new contact when none exists (201)", async () => {
    const res = await ac.syncContact({ email: "sync@parlel.test", firstName: "Sync" });
    expect(res.status).toBe(201);
    expect(res.data.contact.email).toBe("sync@parlel.test");
  });

  it("returns 201 when updating an existing contact by email (real AC behaviour)", async () => {
    await ac.createContact({ email: "exists@parlel.test", firstName: "Old" });
    const res = await ac.syncContact({ email: "exists@parlel.test", firstName: "Updated" });
    // The real /contact/sync endpoint always returns 201 (create OR update).
    expect(res.status).toBe(201);
    expect(res.data.contact.firstName).toBe("Updated");
  });

  it("wraps a top-level fieldValues array alongside contact", async () => {
    const field = (await ac.createField({ title: "City", type: "text" })).data.field.id;
    const res = await ac.syncContact({
      email: "fvsync@parlel.test",
      fieldValues: [{ field, value: "Albany" }],
    });
    expect(res.status).toBe(201);
    expect(Array.isArray(res.data.fieldValues)).toBe(true);
    expect(res.data.fieldValues[0].value).toBe("Albany");
    expect(res.data.fieldValues[0].field).toBe(field);
  });

  it("does not duplicate when syncing twice", async () => {
    await ac.syncContact({ email: "twice@parlel.test" });
    await ac.syncContact({ email: "twice@parlel.test", firstName: "Second" });
    const res = await ac.listContacts("?email=twice@parlel.test");
    expect(res.data.contacts.length).toBe(1);
  });

  it("rejects sync without an email (422)", async () => {
    const res = await ac.syncContact({ firstName: "x" });
    expect(res.status).toBe(422);
  });
});

describe("tags", () => {
  it("creates, gets, lists, updates, deletes a tag", async () => {
    const created = await ac.createTag({ tag: "VIP", tagType: "contact", description: "Top customers" });
    expect(created.status).toBe(201);
    const id = created.data.tag.id;
    expect(created.data.tag.tag).toBe("VIP");

    const got = await ac.getTag(id);
    expect(got.status).toBe(200);

    const listed = await ac.listTags();
    expect(listed.data.tags.length).toBe(1);
    expect(listed.data.meta.total).toBe("1");

    const updated = await ac.updateTag(id, { description: "Updated desc" });
    expect(updated.data.tag.description).toBe("Updated desc");

    const deleted = await ac.deleteTag(id);
    expect(deleted.status).toBe(200);
    expect((await ac.getTag(id)).status).toBe(404);
  });

  it("rejects a tag without a name (422)", async () => {
    const res = await ac.createTag({ tagType: "contact" });
    expect(res.status).toBe(422);
  });

  it("rejects a duplicate tag name (422)", async () => {
    await ac.createTag({ tag: "Dup" });
    const res = await ac.createTag({ tag: "Dup" });
    expect(res.status).toBe(422);
  });
});

describe("contactTags", () => {
  it("applies a tag to a contact", async () => {
    const contact = await makeContact("tagged@parlel.test");
    const tag = (await ac.createTag({ tag: "Newsletter" })).data.tag.id;
    const res = await ac.addTagToContact(contact, tag);
    expect(res.status).toBe(201);
    expect(res.data.contactTag.contact).toBe(contact);
    expect(res.data.contactTag.tag).toBe(tag);
  });

  it("is idempotent when re-applying the same tag", async () => {
    const contact = await makeContact("idem@parlel.test");
    const tag = (await ac.createTag({ tag: "Idem" })).data.tag.id;
    const first = await ac.addTagToContact(contact, tag);
    const second = await ac.addTagToContact(contact, tag);
    expect(second.data.contactTag.id).toBe(first.data.contactTag.id);
    const all = await ac.listContactTags();
    expect(all.data.contactTags.length).toBe(1);
  });

  it("lists contactTags for a contact via nested route", async () => {
    const contact = await makeContact("nested@parlel.test");
    const tag = (await ac.createTag({ tag: "Nested" })).data.tag.id;
    await ac.addTagToContact(contact, tag);
    const res = await ac.contactTags(contact);
    expect(res.status).toBe(200);
    expect(res.data.contactTags.length).toBe(1);
  });

  it("removes a contactTag", async () => {
    const contact = await makeContact("rm@parlel.test");
    const tag = (await ac.createTag({ tag: "Remove" })).data.tag.id;
    const ct = (await ac.addTagToContact(contact, tag)).data.contactTag.id;
    const res = await ac.removeContactTag(ct);
    expect(res.status).toBe(200);
    expect((await ac.listContactTags()).data.contactTags.length).toBe(0);
  });

  it("rejects applying a tag to an unknown contact (422)", async () => {
    const tag = (await ac.createTag({ tag: "Orphan" })).data.tag.id;
    const res = await ac.addTagToContact("999999", tag);
    expect(res.status).toBe(422);
  });

  it("rejects applying an unknown tag (422)", async () => {
    const contact = await makeContact("notag@parlel.test");
    const res = await ac.addTagToContact(contact, "999999");
    expect(res.status).toBe(422);
  });
});

describe("lists & contactLists", () => {
  it("creates, gets, updates, deletes a list", async () => {
    const created = await ac.createList({ name: "Weekly", stringid: "weekly" });
    expect(created.status).toBe(201);
    const id = created.data.list.id;
    expect(created.data.list.name).toBe("Weekly");

    const got = await ac.getList(id);
    expect(got.status).toBe(200);

    const listed = await ac.listLists();
    expect(listed.data.lists.length).toBe(1);

    const updated = await ac.updateList(id, { name: "Monthly" });
    expect(updated.data.list.name).toBe("Monthly");

    const deleted = await ac.deleteList(id);
    expect(deleted.status).toBe(200);
  });

  it("rejects a list without a name (422)", async () => {
    const res = await ac.createList({});
    expect(res.status).toBe(422);
  });

  it("subscribes and unsubscribes a contact to/from a list", async () => {
    const list = (await ac.createList({ name: "Promo" })).data.list.id;
    const contact = await makeContact("sub@parlel.test");

    const sub = await ac.updateListStatus(list, contact, "1");
    expect(sub.status).toBe(200);
    expect(sub.data.contactList.status).toBe("1");

    // subscriber_count reflects subscription
    const afterSub = await ac.getList(list);
    expect(afterSub.data.list.subscriber_count).toBe("1");

    const unsub = await ac.updateListStatus(list, contact, "2");
    expect(unsub.data.contactList.status).toBe("2");
    expect(unsub.data.contactList.id).toBe(sub.data.contactList.id); // same link, updated

    const afterUnsub = await ac.getList(list);
    expect(afterUnsub.data.list.subscriber_count).toBe("0");
  });

  it("lists contactLists for a contact via nested route", async () => {
    const list = (await ac.createList({ name: "Nested" })).data.list.id;
    const contact = await makeContact("nl@parlel.test");
    await ac.updateListStatus(list, contact, "1");
    const res = await ac.contactLists(contact);
    expect(res.data.contactLists.length).toBe(1);
  });

  it("filters contacts by listid", async () => {
    const list = (await ac.createList({ name: "Filtered" })).data.list.id;
    const c1 = await makeContact("in@parlel.test");
    await makeContact("out@parlel.test");
    await ac.updateListStatus(list, c1, "1");
    const res = await ac.listContacts(`?listid=${list}`);
    expect(res.data.contacts.length).toBe(1);
    expect(res.data.contacts[0].id).toBe(c1);
  });

  it("rejects subscribing an unknown contact (422)", async () => {
    const list = (await ac.createList({ name: "X" })).data.list.id;
    const res = await ac.updateListStatus(list, "999999", "1");
    expect(res.status).toBe(422);
  });

  it("rejects subscribing to an unknown list (422)", async () => {
    const contact = await makeContact("ul@parlel.test");
    const res = await ac.updateListStatus("999999", contact, "1");
    expect(res.status).toBe(422);
  });
});

describe("custom fields & field values", () => {
  it("creates, gets, updates, deletes a custom field", async () => {
    const created = await ac.createField({ title: "Birthday", type: "date", perstag: "BIRTHDAY" });
    expect(created.status).toBe(201);
    const id = created.data.field.id;
    expect(created.data.field.title).toBe("Birthday");
    expect(created.data.field.perstag).toBe("BIRTHDAY");

    expect((await ac.getField(id)).status).toBe(200);
    expect((await ac.listFields()).data.fields.length).toBe(1);

    const updated = await ac.updateField(id, { title: "DOB" });
    expect(updated.data.field.title).toBe("DOB");

    expect((await ac.deleteField(id)).status).toBe(200);
    expect((await ac.getField(id)).status).toBe(404);
  });

  it("rejects a field without title/type (422)", async () => {
    const res = await ac.createField({ title: "NoType" });
    expect(res.status).toBe(422);
  });

  it("sets, updates and deletes a field value for a contact", async () => {
    const contact = await makeContact("fv@parlel.test");
    const field = (await ac.createField({ title: "Plan", type: "text" })).data.field.id;

    const set = await ac.setFieldValue(contact, field, "pro");
    expect(set.status).toBe(201);
    expect(set.data.fieldValue.value).toBe("pro");
    const fvId = set.data.fieldValue.id;

    // upsert: setting again updates the same record
    const again = await ac.setFieldValue(contact, field, "enterprise");
    expect(again.data.fieldValue.id).toBe(fvId);
    expect(again.data.fieldValue.value).toBe("enterprise");

    const updated = await ac.updateFieldValue(fvId, "free");
    expect(updated.data.fieldValue.value).toBe("free");

    const nested = await ac.contactFieldValues(contact);
    expect(nested.data.fieldValues.length).toBe(1);

    expect((await ac.deleteFieldValue(fvId)).status).toBe(200);
    expect((await ac.getFieldValue(fvId)).status).toBe(404);
  });

  it("rejects a field value for an unknown contact (422)", async () => {
    const field = (await ac.createField({ title: "F", type: "text" })).data.field.id;
    const res = await ac.setFieldValue("999999", field, "x");
    expect(res.status).toBe(422);
  });

  it("rejects a field value for an unknown field (422)", async () => {
    const contact = await makeContact("ff@parlel.test");
    const res = await ac.setFieldValue(contact, "999999", "x");
    expect(res.status).toBe(422);
  });

  it("accepts inline contact.fieldValues on create and persists them", async () => {
    const field = (await ac.createField({ title: "Plan", type: "text" })).data.field.id;
    const created = await ac.createContact({
      email: "inline@parlel.test",
      fieldValues: [{ field, value: "enterprise" }],
    });
    expect(created.status).toBe(201);
    const contactId = created.data.contact.id;
    const nested = await ac.contactFieldValues(contactId);
    expect(nested.data.fieldValues.length).toBe(1);
    expect(nested.data.fieldValues[0].value).toBe("enterprise");
  });

  it("ignores inline fieldValues that reference an unknown field (lenient, like real AC)", async () => {
    const created = await ac.createContact({
      email: "inline2@parlel.test",
      fieldValues: [{ field: "999999", value: "x" }],
    });
    expect(created.status).toBe(201);
    const nested = await ac.contactFieldValues(created.data.contact.id);
    expect(nested.data.fieldValues.length).toBe(0);
  });
});

describe("deals, pipelines & stages", () => {
  it("lists seeded pipelines and stages", async () => {
    const groups = await ac.listDealGroups();
    expect(groups.data.dealGroups[0].title).toBe("Default Pipeline");
    const stages = await ac.listDealStages();
    expect(stages.data.dealStages.length).toBeGreaterThanOrEqual(5);
  });

  it("creates a pipeline and a stage in it", async () => {
    const pipeline = await ac.createDealGroup({ title: "Sales", currency: "eur" });
    expect(pipeline.status).toBe(201);
    const gid = pipeline.data.dealGroup.id;

    const stage = await ac.createDealStage({ title: "Lead", group: gid });
    expect(stage.status).toBe(201);
    expect(stage.data.dealStage.group).toBe(gid);
  });

  it("rejects a stage with an unknown pipeline (422)", async () => {
    const res = await ac.createDealStage({ title: "Bad", group: "999999" });
    expect(res.status).toBe(422);
  });

  it("creates, gets, updates, deletes a deal", async () => {
    const stageId = (await ac.listDealStages()).data.dealStages[0].id;
    const contact = await makeContact("deal@parlel.test");
    const created = await ac.createDeal({ title: "Big Deal", value: "10000", currency: "usd", contact, stage: stageId });
    expect(created.status).toBe(201);
    const id = created.data.deal.id;
    expect(created.data.deal.title).toBe("Big Deal");
    expect(created.data.deal.stage).toBe(stageId);

    expect((await ac.getDeal(id)).status).toBe(200);
    expect((await ac.listDeals()).data.deals.length).toBe(1);

    const updated = await ac.updateDeal(id, { value: "20000", status: "1" });
    expect(updated.data.deal.value).toBe("20000");
    expect(updated.data.deal.status).toBe("1");

    expect((await ac.deleteDeal(id)).status).toBe(200);
    expect((await ac.getDeal(id)).status).toBe(404);
  });

  it("wraps the deal-create response in { contacts, deal, dealStages } (real AC envelope)", async () => {
    const stageId = (await ac.listDealStages()).data.dealStages[0].id;
    const contact = await makeContact("dealwrap@parlel.test");
    const res = await ac.createDeal({ title: "Wrapped", value: 45600, currency: "usd", contact, stage: stageId });
    expect(res.status).toBe(201);
    // Real POST /deals returns related contacts + dealStages alongside the deal.
    expect(Array.isArray(res.data.contacts)).toBe(true);
    expect(res.data.contacts[0].id).toBe(contact);
    expect(Array.isArray(res.data.dealStages)).toBe(true);
    expect(res.data.dealStages[0].id).toBe(stageId);
    // Deal carries the extra real-API fields.
    expect(res.data.deal).toHaveProperty("hash");
    expect(res.data.deal).toHaveProperty("nextdate");
    expect(res.data.deal).toHaveProperty("winProbability");
    expect(res.data.deal).toHaveProperty("isDisabled");
    expect(Array.isArray(res.data.deal.fields)).toBe(true);
  });

  it("echoes deal custom fields [{customFieldId, fieldValue, dealId}]", async () => {
    const res = await ac.createDeal({
      title: "WithFields",
      value: 100,
      currency: "usd",
      fields: [{ customFieldId: 1, fieldValue: "First field value" }],
    });
    expect(res.status).toBe(201);
    expect(res.data.deal.fields[0].customFieldId).toBe(1);
    expect(res.data.deal.fields[0].fieldValue).toBe("First field value");
    expect(res.data.deal.fields[0].dealId).toBe(res.data.deal.id);
  });

  it("rejects a deal without a title (422)", async () => {
    const res = await ac.createDeal({ value: "10" });
    expect(res.status).toBe(422);
  });

  it("returns a source-free 422 error envelope { errors: [{ title, code }] }", async () => {
    const res = await ac.createDeal({ value: "10" });
    expect(res.status).toBe(422);
    expect(res.data.errors[0]).toHaveProperty("title");
    expect(res.data.errors[0]).not.toHaveProperty("source");
  });

  it("rejects a deal with an unknown stage (422)", async () => {
    const res = await ac.createDeal({ title: "X", stage: "999999" });
    expect(res.status).toBe(422);
  });

  it("updates and deletes seeded/created pipelines and stages", async () => {
    const gid = (await ac.createDealGroup({ title: "Temp" })).data.dealGroup.id;
    const upd = await ac.updateDealGroup(gid, { title: "Renamed" });
    expect(upd.data.dealGroup.title).toBe("Renamed");
    expect((await ac.deleteDealGroup(gid)).status).toBe(200);

    const sid = (await ac.createDealStage({ title: "Temp", group: (await ac.listDealGroups()).data.dealGroups[0].id })).data.dealStage.id;
    const supd = await ac.updateDealStage(sid, { title: "Renamed Stage" });
    expect(supd.data.dealStage.title).toBe("Renamed Stage");
    expect((await ac.deleteDealStage(sid)).status).toBe(200);
  });
});

describe("notes", () => {
  it("creates, gets, updates, deletes a note", async () => {
    const created = await ac.createNote({ note: "Called the lead", reltype: "Subscriber", relid: "1" });
    expect(created.status).toBe(201);
    const id = created.data.note.id;
    expect(created.data.note.note).toBe("Called the lead");

    expect((await ac.getNote(id)).status).toBe(200);
    expect((await ac.listNotes()).data.notes.length).toBe(1);

    const updated = await ac.updateNote(id, { note: "Followed up" });
    expect(updated.data.note.note).toBe("Followed up");

    expect((await ac.deleteNote(id)).status).toBe(200);
    expect((await ac.getNote(id)).status).toBe(404);
  });

  it("rejects a note without text (422)", async () => {
    const res = await ac.createNote({ reltype: "Subscriber" });
    expect(res.status).toBe(422);
  });
});

describe("accounts (CRM)", () => {
  it("creates, gets, updates, deletes an account", async () => {
    const created = await ac.createAccount({ name: "Acme Inc", accountUrl: "https://acme.test" });
    expect(created.status).toBe(201);
    const id = created.data.account.id;
    expect(created.data.account.name).toBe("Acme Inc");

    expect((await ac.getAccount(id)).status).toBe(200);
    expect((await ac.listAccounts()).data.accounts.length).toBe(1);

    const updated = await ac.updateAccount(id, { name: "Acme LLC" });
    expect(updated.data.account.name).toBe("Acme LLC");

    expect((await ac.deleteAccount(id)).status).toBe(200);
    expect((await ac.getAccount(id)).status).toBe(404);
  });

  it("rejects an account without a name (422)", async () => {
    const res = await ac.createAccount({ accountUrl: "https://x.test" });
    expect(res.status).toBe(422);
  });
});

describe("campaigns, automations, segments, users (read-only)", () => {
  it("lists and gets a campaign", async () => {
    const list = await ac.listCampaigns();
    expect(list.status).toBe(200);
    const id = list.data.campaigns[0].id;
    const got = await ac.getCampaign(id);
    expect(got.status).toBe(200);
    expect(got.data.campaign.id).toBe(id);
  });

  it("404s an unknown campaign", async () => {
    expect((await ac.getCampaign("999999")).status).toBe(404);
  });

  it("lists and gets an automation", async () => {
    const list = await ac.listAutomations();
    const id = list.data.automations[0].id;
    expect((await ac.getAutomation(id)).data.automation.id).toBe(id);
  });

  it("lists and gets a segment", async () => {
    const list = await ac.listSegments();
    const id = list.data.segments[0].id;
    expect((await ac.getSegment(id)).data.segment.id).toBe(id);
  });

  it("lists and gets a user", async () => {
    const list = await ac.listUsers();
    const id = list.data.users[0].id;
    expect((await ac.getUser(id)).data.user.id).toBe(id);
  });
});

describe("contactAutomations", () => {
  it("enrols a contact into an automation", async () => {
    const contact = await makeContact("enrol@parlel.test");
    const automation = (await ac.listAutomations()).data.automations[0].id;
    const res = await ac.enrolContact(contact, automation);
    expect(res.status).toBe(201);
    expect(res.data.contactAutomation.contact).toBe(contact);
    expect(res.data.contactAutomation.automation).toBe(automation);
    const id = res.data.contactAutomation.id;

    expect((await ac.getContactAutomation(id)).status).toBe(200);
    expect((await ac.listContactAutomations()).data.contactAutomations.length).toBe(1);

    expect((await ac.removeContactAutomation(id)).status).toBe(200);
    expect((await ac.listContactAutomations()).data.contactAutomations.length).toBe(0);
  });

  it("rejects enrolling an unknown contact (422)", async () => {
    const automation = (await ac.listAutomations()).data.automations[0].id;
    const res = await ac.enrolContact("999999", automation);
    expect(res.status).toBe(422);
  });

  it("rejects enrolling into an unknown automation (422)", async () => {
    const contact = await makeContact("ne@parlel.test");
    const res = await ac.enrolContact(contact, "999999");
    expect(res.status).toBe(422);
  });
});

describe("webhooks", () => {
  it("creates, gets, lists, updates, deletes a webhook", async () => {
    const created = await ac.createWebhook({ name: "Sub Hook", url: "https://hooks.parlel.test/ac", events: ["subscribe", "unsubscribe"] });
    expect(created.status).toBe(201);
    const id = created.data.webhook.id;
    expect(created.data.webhook.events).toEqual(["subscribe", "unsubscribe"]);

    expect((await ac.getWebhook(id)).status).toBe(200);
    expect((await ac.listWebhooks()).data.webhooks.length).toBe(1);

    const updated = await ac.updateWebhook(id, { name: "Renamed Hook", events: ["subscribe"] });
    expect(updated.data.webhook.name).toBe("Renamed Hook");
    expect(updated.data.webhook.events).toEqual(["subscribe"]);

    expect((await ac.deleteWebhook(id)).status).toBe(200);
    expect((await ac.getWebhook(id)).status).toBe(404);
  });

  it("rejects a webhook without name/url (422)", async () => {
    const res = await ac.createWebhook({ name: "NoUrl" });
    expect(res.status).toBe(422);
  });
});

describe("reset & state isolation", () => {
  it("wipes user data on reset but keeps seeded defaults", async () => {
    await ac.createContact({ email: "wipe@parlel.test" });
    await ac.createTag({ tag: "Wipe" });
    let state = (await api("GET", "/__parlel/state", undefined, {})).body;
    expect(state.contacts).toBe(1);
    expect(state.tags).toBe(1);

    await api("POST", "/__parlel/reset", undefined, {});
    state = (await api("GET", "/__parlel/state", undefined, {})).body;
    expect(state.contacts).toBe(0);
    expect(state.tags).toBe(0);
    // seeded defaults remain
    expect(state.dealStages).toBeGreaterThanOrEqual(5);
    expect(state.users).toBeGreaterThanOrEqual(1);
  });
});
