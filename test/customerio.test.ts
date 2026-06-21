import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CustomerioServer } from "../services/customerio/src/server.js";

const PORT = 14668;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SITE_ID = "parlel-site-id";
const API_KEY = "parlel-api-key";
const APP_KEY = "parlel-app-key";
const WRITE_KEY = "parlel-write-key";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

// Raw HTTP helper for direct endpoint / control-plane assertions.
async function raw(method: string, path: string, body?: Json, headers: Json = {}): Promise<ApiResult> {
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

// ---------------------------------------------------------------------------
// Faithful, dependency-free re-implementations of the three `customerio-node`
// clients. These mirror lib/track.ts, lib/api.ts, and lib/pipelines.ts on the
// wire so we exercise the exact protocol the real SDK speaks. A non-2xx
// response throws a CustomerIORequestError just like the SDK.
// ---------------------------------------------------------------------------

class CustomerIORequestError extends Error {
  statusCode: number;
  body: string;
  constructor(json: Json | null, statusCode: number, body: string) {
    super(CustomerIORequestError.composeMessage(json));
    this.name = "CustomerIORequestError";
    this.statusCode = statusCode;
    this.body = body;
  }
  static composeMessage(json: Json | null): string {
    if (!json) return "Unknown error";
    if (json.meta && json.meta.error) return json.meta.error;
    if (json.meta && json.meta.errors) {
      const count = json.meta.errors.length;
      return `${count} ${count === 1 ? "error" : "errors"}:\n${json.meta.errors
        .map((e: string) => `  - ${e}`)
        .join("\n")}`;
    }
    return "Unknown error";
  }
}

class MissingParamError extends Error {
  constructor(param: string) {
    super(`${param} is required`);
    this.name = "MissingParamError";
  }
}

const isEmpty = (value: any) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
};

async function transport(method: string, uri: string, auth: string, data?: Json): Promise<Json> {
  const body = data ? JSON.stringify(data) : null;
  const headers: Json = {
    Authorization: auth,
    "Content-Type": "application/json",
    "User-Agent": "Customer.io Node Client/test",
  };
  const response = await fetch(uri, { method, headers, body: body ?? undefined });
  const text = await response.text();
  let json: Json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Unable to parse JSON. Body:\n${text}`);
    }
  }
  if (response.status >= 200 && response.status < 300) return json;
  throw new CustomerIORequestError(json, response.status, text);
}

function basicAuth(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

// ----- TrackClient -----
class TrackClient {
  siteid: string;
  apikey: string;
  auth: string;
  trackRoot: string;
  trackV2Root: string;
  constructor(siteid: string, apikey: string, url: string) {
    this.siteid = siteid;
    this.apikey = apikey;
    this.auth = basicAuth(siteid, apikey);
    this.trackRoot = `${url}/api/v1`;
    this.trackV2Root = `${url}/api/v2`;
  }
  identify(customerId: string | number, data: Json = {}) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    return transport("PUT", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}`, this.auth, data);
  }
  destroy(customerId: string | number) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    return transport("DELETE", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}`, this.auth);
  }
  suppress(customerId: string | number) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    return transport("POST", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}/suppress`, this.auth);
  }
  unsuppress(customerId: string | number) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    return transport("POST", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}/unsuppress`, this.auth);
  }
  track(customerId: string | number, data: Json = {}) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    if (isEmpty(data.name)) throw new MissingParamError("data.name");
    return transport("POST", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}/events`, this.auth, data);
  }
  trackAnonymous(anonymousId: string | number, data: Json = {}) {
    if (isEmpty(data.name)) throw new MissingParamError("data.name");
    const payload: Json = { ...data };
    if (!isEmpty(anonymousId)) payload.anonymous_id = anonymousId;
    return transport("POST", `${this.trackRoot}/events`, this.auth, payload);
  }
  trackPageView(customerId: string | number, path: string) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    if (isEmpty(path)) throw new MissingParamError("path");
    return transport("POST", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}/events`, this.auth, {
      type: "page",
      name: path,
    });
  }
  trackPush(data: Json = {}) {
    return transport("POST", `${this.trackRoot}/push/events`, this.auth, data);
  }
  addDevice(customerId: string | number, deviceId: string, platform: string, data: Json = {}) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    if (isEmpty(deviceId)) throw new MissingParamError("device_id");
    if (isEmpty(platform)) throw new MissingParamError("platform");
    const { last_used, ...attributes } = data;
    return transport("PUT", `${this.trackRoot}/customers/${encodeURIComponent(customerId)}/devices`, this.auth, {
      device: {
        id: deviceId,
        platform,
        ...(last_used ? { last_used } : {}),
        ...(Object.keys(attributes).length ? { attributes } : {}),
      },
    });
  }
  deleteDevice(customerId: string | number, deviceToken: string | number) {
    if (isEmpty(customerId)) throw new MissingParamError("customerId");
    if (isEmpty(deviceToken)) throw new MissingParamError("deviceToken");
    return transport(
      "DELETE",
      `${this.trackRoot}/customers/${encodeURIComponent(customerId)}/devices/${encodeURIComponent(deviceToken)}`,
      this.auth,
    );
  }
  batch(operations: Json[]) {
    if (!Array.isArray(operations) || operations.length === 0) throw new MissingParamError("operations");
    return transport("POST", `${this.trackV2Root}/batch`, this.auth, { batch: operations });
  }
  mergeCustomers(primaryType: string, primaryId: any, secondaryType: string, secondaryId: any) {
    if (isEmpty(primaryId)) throw new MissingParamError("primaryId");
    if (isEmpty(secondaryId)) throw new MissingParamError("secondaryId");
    return transport("POST", `${this.trackRoot}/merge_customers`, this.auth, {
      primary: { [primaryType]: primaryId },
      secondary: { [secondaryType]: secondaryId },
    });
  }
}

// ----- APIClient -----
class APIClient {
  auth: string;
  apiRoot: string;
  constructor(appKey: string, url: string) {
    this.auth = `Bearer ${appKey}`;
    this.apiRoot = `${url}/v1`;
  }
  sendEmail(message: Json) {
    return transport("POST", `${this.apiRoot}/send/email`, this.auth, message);
  }
  sendPush(message: Json) {
    return transport("POST", `${this.apiRoot}/send/push`, this.auth, message);
  }
  sendSMS(message: Json) {
    return transport("POST", `${this.apiRoot}/send/sms`, this.auth, message);
  }
  sendInboxMessage(message: Json) {
    return transport("POST", `${this.apiRoot}/send/inbox_message`, this.auth, message);
  }
  sendInApp(message: Json) {
    return transport("POST", `${this.apiRoot}/send/in_app`, this.auth, message);
  }
  getCustomersByEmail(email: string) {
    if (typeof email !== "string" || isEmpty(email)) throw new Error('"email" must be a string');
    return transport("GET", `${this.apiRoot}/customers?email=${encodeURIComponent(email)}`, this.auth);
  }
  getAttributes(id: string | number, idType = "id") {
    if (isEmpty(id)) throw new MissingParamError("id");
    return transport(
      "GET",
      `${this.apiRoot}/customers/${encodeURIComponent(id)}/attributes?id_type=${idType}`,
      this.auth,
    );
  }
  triggerBroadcast(broadcastId: string | number, data: Json, recipients: Json) {
    return transport("POST", `${this.apiRoot}/campaigns/${encodeURIComponent(broadcastId)}/triggers`, this.auth, {
      data,
      recipients,
    });
  }
  listExports() {
    return transport("GET", `${this.apiRoot}/exports`, this.auth);
  }
  getExport(id: string | number) {
    if (isEmpty(id)) throw new MissingParamError("id");
    return transport("GET", `${this.apiRoot}/exports/${encodeURIComponent(id)}`, this.auth);
  }
  downloadExport(id: string | number) {
    if (isEmpty(id)) throw new MissingParamError("id");
    return transport("GET", `${this.apiRoot}/exports/${encodeURIComponent(id)}/download`, this.auth);
  }
  createCustomersExport(filters: Json) {
    if (filters == null) throw new MissingParamError("filters");
    return transport("POST", `${this.apiRoot}/exports/customers`, this.auth, { filters });
  }
  createDeliveriesExport(newsletterId: number, options: Json = {}) {
    if (isEmpty(newsletterId)) throw new MissingParamError("newsletterId");
    return transport("POST", `${this.apiRoot}/exports/deliveries`, this.auth, {
      newsletter_id: newsletterId,
      ...options,
    });
  }
}

// ----- PipelinesClient -----
class PipelinesClient {
  auth: string;
  root: string;
  constructor(writeKey: string, url: string) {
    if (isEmpty(writeKey)) throw new MissingParamError("writeKey");
    this.auth = basicAuth(writeKey, "");
    this.root = `${url}/v1`;
  }
  private envelope(payload: Json) {
    return {
      ...payload,
      messageId: payload.messageId ?? crypto.randomUUID(),
      timestamp: payload.timestamp ?? new Date().toISOString(),
      context: { ...(payload.context ?? {}), library: { name: "customerio-node", version: "test" } },
    };
  }
  identify(payload: Json) {
    if (isEmpty(payload?.userId) && isEmpty(payload?.anonymousId)) throw new MissingParamError("userId or anonymousId");
    return transport("POST", `${this.root}/identify`, this.auth, this.envelope(payload));
  }
  track(payload: Json) {
    if (isEmpty(payload?.userId) && isEmpty(payload?.anonymousId)) throw new MissingParamError("userId or anonymousId");
    if (isEmpty(payload?.event)) throw new MissingParamError("event");
    return transport("POST", `${this.root}/track`, this.auth, this.envelope(payload));
  }
  page(payload: Json) {
    if (isEmpty(payload?.userId) && isEmpty(payload?.anonymousId)) throw new MissingParamError("userId or anonymousId");
    return transport("POST", `${this.root}/page`, this.auth, this.envelope(payload));
  }
  screen(payload: Json) {
    if (isEmpty(payload?.userId) && isEmpty(payload?.anonymousId)) throw new MissingParamError("userId or anonymousId");
    return transport("POST", `${this.root}/screen`, this.auth, this.envelope(payload));
  }
  group(payload: Json) {
    if (isEmpty(payload?.userId) && isEmpty(payload?.anonymousId)) throw new MissingParamError("userId or anonymousId");
    if (isEmpty(payload?.groupId)) throw new MissingParamError("groupId");
    return transport("POST", `${this.root}/group`, this.auth, this.envelope(payload));
  }
  alias(payload: Json) {
    if (isEmpty(payload?.userId)) throw new MissingParamError("userId");
    if (isEmpty(payload?.previousId)) throw new MissingParamError("previousId");
    return transport("POST", `${this.root}/alias`, this.auth, this.envelope(payload));
  }
  batch(items: Json[]) {
    if (!Array.isArray(items) || items.length === 0) throw new MissingParamError("items");
    const batch = items.map((item) => ({ ...this.envelope(item), type: item.type }));
    return transport("POST", `${this.root}/batch`, this.auth, { batch });
  }
}

// ---------------------------------------------------------------------------

const server = new CustomerioServer(PORT);
let cio: TrackClient;
let api: APIClient;
let pipelines: PipelinesClient;

beforeAll(async () => {
  await server.start();
  cio = new TrackClient(SITE_ID, API_KEY, BASE_URL);
  api = new APIClient(APP_KEY, BASE_URL);
  pipelines = new PipelinesClient(WRITE_KEY, BASE_URL);
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  await raw("POST", "/__parlel/reset");
});

describe("customerio: infrastructure", () => {
  it("responds to health check", async () => {
    const res = await raw("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("exposes root metadata", async () => {
    const res = await raw("GET", "/");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("customerio");
    expect(res.body.apis).toEqual(expect.arrayContaining(["track", "app", "pipelines"]));
  });

  it("handles CORS preflight", async () => {
    const res = await raw("OPTIONS", "/api/v1/customers/1");
    expect(res.status).toBe(204);
  });

  it("returns 404 for unknown path", async () => {
    const res = await raw("GET", "/nope");
    expect(res.status).toBe(404);
  });
});

describe("customerio: authentication", () => {
  it("rejects Track API without Basic auth", async () => {
    const res = await raw("PUT", "/api/v1/customers/1", { email: "a@b.com" });
    expect(res.status).toBe(401);
    expect(res.body.meta.errors).toBeDefined();
  });

  it("rejects App API without Bearer auth", async () => {
    const res = await raw("POST", "/v1/send/email", { transactional_message_id: "1" });
    expect(res.status).toBe(401);
  });

  it("rejects Pipelines API without Basic auth", async () => {
    const res = await raw("POST", "/v1/identify", { userId: "1" });
    expect(res.status).toBe(401);
  });

  it("accepts Basic auth on Track API", async () => {
    const res = await raw("PUT", "/api/v1/customers/1", { email: "a@b.com" }, { Authorization: basicAuth(SITE_ID, API_KEY) });
    expect(res.status).toBe(200);
  });
});

describe("customerio: TrackClient.identify", () => {
  it("creates a person", async () => {
    await cio.identify("1", { email: "bob@example.com", first_name: "Bob", plan: "basic" });
    const got = await raw("GET", "/__parlel/customers/1");
    expect(got.status).toBe(200);
    expect(got.body.attributes.email).toBe("bob@example.com");
    expect(got.body.attributes.first_name).toBe("Bob");
    expect(got.body.cio_id).toBeDefined();
  });

  it("updates an existing person (merges attributes)", async () => {
    await cio.identify("1", { email: "bob@example.com", plan: "basic" });
    await cio.identify("1", { plan: "pro" });
    const got = await raw("GET", "/__parlel/customers/1");
    expect(got.body.attributes.plan).toBe("pro");
    expect(got.body.attributes.email).toBe("bob@example.com");
  });

  it("accepts numeric ids", async () => {
    const res = await cio.identify(42, { email: "n@example.com" });
    expect(res).toEqual({});
  });

  it("throws MissingParamError for empty id", () => {
    expect(() => cio.identify("")).toThrow(MissingParamError);
  });
});

describe("customerio: TrackClient.destroy", () => {
  it("deletes a person", async () => {
    await cio.identify("1", { email: "x@example.com" });
    await cio.destroy("1");
    const got = await raw("GET", "/__parlel/customers/1");
    expect(got.status).toBe(404);
  });

  it("is idempotent for non-existent person", async () => {
    const res = await cio.destroy("ghost");
    expect(res).toEqual({});
  });

  it("throws for empty id", () => {
    expect(() => cio.destroy("")).toThrow(MissingParamError);
  });
});

describe("customerio: TrackClient.suppress / unsuppress", () => {
  it("suppresses a person (deletes + marks suppressed)", async () => {
    await cio.identify("1", { email: "s@example.com" });
    await cio.suppress("1");
    const sup = await raw("GET", "/__parlel/suppressed");
    expect(sup.body.suppressed).toContain("1");
    const got = await raw("GET", "/__parlel/customers/1");
    expect(got.status).toBe(404);
  });

  it("unsuppresses a person", async () => {
    await cio.suppress("1");
    await cio.unsuppress("1");
    const sup = await raw("GET", "/__parlel/suppressed");
    expect(sup.body.suppressed).not.toContain("1");
  });

  it("throws for empty ids", () => {
    expect(() => cio.suppress("")).toThrow(MissingParamError);
    expect(() => cio.unsuppress("")).toThrow(MissingParamError);
  });
});

describe("customerio: TrackClient.track", () => {
  it("records a simple event", async () => {
    await cio.identify("1", { email: "e@example.com" });
    await cio.track("1", { name: "updated" });
    const evts = await raw("GET", "/__parlel/events");
    expect(evts.body.count).toBe(1);
    expect(evts.body.events[0].name).toBe("updated");
    expect(evts.body.events[0].customer_id).toBe("1");
  });

  it("records an event with data", async () => {
    await cio.track("1", { name: "purchase", data: { price: "23.45", product: "socks" } });
    const evts = await raw("GET", "/__parlel/events");
    expect(evts.body.events[0].data.product).toBe("socks");
  });

  it("rejects an event without a name (client guard)", () => {
    expect(() => cio.track("1", {} as any)).toThrow(MissingParamError);
  });

  it("rejects an event with no name server-side", async () => {
    const res = await raw("POST", "/api/v1/customers/1/events", {}, { Authorization: basicAuth(SITE_ID, API_KEY) });
    expect(res.status).toBe(400);
    expect(res.body.meta.errors).toBeDefined();
  });
});

describe("customerio: TrackClient.trackAnonymous", () => {
  it("records an anonymous event", async () => {
    await cio.trackAnonymous("anon-1", { name: "updated", data: { plan: "free" } });
    const evts = await raw("GET", "/__parlel/events");
    expect(evts.body.events[0].kind).toBe("anonymous");
    expect(evts.body.events[0].anonymous_id).toBe("anon-1");
  });

  it("supports anonymous invite events (empty id)", async () => {
    await cio.trackAnonymous("", { name: "invite", data: { recipient: "alex@example.com" } });
    const evts = await raw("GET", "/__parlel/events");
    expect(evts.body.events[0].name).toBe("invite");
    expect(evts.body.events[0].anonymous_id).toBeNull();
  });

  it("throws without a name", () => {
    expect(() => cio.trackAnonymous("a", {} as any)).toThrow(MissingParamError);
  });
});

describe("customerio: TrackClient.trackPageView", () => {
  it("records a page view event", async () => {
    await cio.trackPageView("1", "/home");
    const evts = await raw("GET", "/__parlel/events");
    expect(evts.body.events[0].kind).toBe("page");
    expect(evts.body.events[0].type).toBe("page");
    expect(evts.body.events[0].name).toBe("/home");
  });

  it("throws for empty path", () => {
    expect(() => cio.trackPageView("1", "")).toThrow(MissingParamError);
  });
});

describe("customerio: TrackClient.trackPush", () => {
  it("records a push lifecycle event", async () => {
    await cio.trackPush({ delivery_id: "d1", device_id: "dev1", event: "opened", timestamp: 1700000000 });
    const evts = await raw("GET", "/__parlel/events");
    expect(evts.body.events[0].kind).toBe("push");
    expect(evts.body.events[0].event).toBe("opened");
  });
});

describe("customerio: TrackClient devices", () => {
  it("adds a device", async () => {
    await cio.addDevice("1", "device_token_abc", "ios", { primary: true });
    const devs = await raw("GET", "/__parlel/devices");
    expect(devs.body.count).toBe(1);
    expect(devs.body.devices[0].id).toBe("device_token_abc");
    expect(devs.body.devices[0].platform).toBe("ios");
    expect(devs.body.devices[0].attributes.primary).toBe(true);
  });

  it("adds a device with last_used kept off attributes", async () => {
    await cio.addDevice("1", "tok", "android", { last_used: 1700000000, foo: "bar" });
    const devs = await raw("GET", "/__parlel/devices");
    expect(devs.body.devices[0].last_used).toBe(1700000000);
    expect(devs.body.devices[0].attributes.foo).toBe("bar");
    expect(devs.body.devices[0].attributes.last_used).toBeUndefined();
  });

  it("deletes a device", async () => {
    await cio.addDevice("1", "tok", "ios");
    await cio.deleteDevice("1", "tok");
    const devs = await raw("GET", "/__parlel/devices");
    expect(devs.body.count).toBe(0);
  });

  it("throws for missing device params", () => {
    expect(() => cio.addDevice("1", "", "ios")).toThrow(MissingParamError);
    expect(() => cio.addDevice("1", "tok", "")).toThrow(MissingParamError);
    expect(() => cio.deleteDevice("1", "")).toThrow(MissingParamError);
  });

  it("rejects addDevice with no device id server-side", async () => {
    const res = await raw("PUT", "/api/v1/customers/1/devices", { device: {} }, { Authorization: basicAuth(SITE_ID, API_KEY) });
    expect(res.status).toBe(400);
  });
});

describe("customerio: TrackClient.mergeCustomers", () => {
  it("merges two people, deleting the secondary", async () => {
    await cio.identify("primary", { email: "p@example.com" });
    await cio.identify("secondary", { email: "s@example.com" });
    await cio.mergeCustomers("id", "primary", "id", "secondary");
    const primary = await raw("GET", "/__parlel/customers/primary");
    const secondary = await raw("GET", "/__parlel/customers/secondary");
    expect(primary.status).toBe(200);
    expect(secondary.status).toBe(404);
    const merges = await raw("GET", "/__parlel/merges");
    expect(merges.body.count).toBe(1);
  });

  it("supports cross-type merges (email into id)", async () => {
    const res = await cio.mergeCustomers("id", "cool.person@company.com", "email", "cperson@gmail.com");
    expect(res).toEqual({});
  });

  it("throws for empty identifiers", () => {
    expect(() => cio.mergeCustomers("id", "", "id", "x")).toThrow(MissingParamError);
    expect(() => cio.mergeCustomers("id", "x", "id", "")).toThrow(MissingParamError);
  });
});

describe("customerio: TrackClient.batch (v2)", () => {
  it("submits a batch of operations", async () => {
    await cio.batch([
      { type: "person", action: "identify", identifiers: { id: "1" }, attributes: { plan: "pro" } },
      { type: "person", action: "event", identifiers: { id: "1" }, name: "signup" },
    ]);
    const batches = await raw("GET", "/__parlel/batches");
    expect(batches.body.count).toBe(1);
    expect(batches.body.batches[0].operations).toHaveLength(2);
    // identify op materializes a customer.
    const cust = await raw("GET", "/__parlel/customers/1");
    expect(cust.status).toBe(200);
    expect(cust.body.attributes.plan).toBe("pro");
  });

  it("throws for empty operations", () => {
    expect(() => cio.batch([])).toThrow(MissingParamError);
  });

  it("rejects empty batch server-side", async () => {
    const res = await raw("POST", "/api/v2/batch", { batch: [] }, { Authorization: basicAuth(SITE_ID, API_KEY) });
    expect(res.status).toBe(400);
  });
});

describe("customerio: APIClient transactional sends", () => {
  it("sends a transactional email (template)", async () => {
    const res = await api.sendEmail({
      to: "person@example.com",
      transactional_message_id: "3",
      identifiers: { email: "person@example.com" },
      message_data: { name: "Person" },
    });
    expect(res.delivery_id).toBeDefined();
    expect(res.queued).toBe(true);
    const dels = await raw("GET", "/__parlel/deliveries");
    expect(dels.body.count).toBe(1);
    expect(dels.body.deliveries[0].channel).toBe("email");
  });

  it("sends a transactional email (inline body)", async () => {
    const res = await api.sendEmail({
      to: "person@example.com",
      identifiers: { email: "person@example.com" },
      from: "team@parlel.test",
      subject: "Hi",
      body: "<p>hello</p>",
    });
    expect(res.delivery_id).toBeDefined();
  });

  it("rejects email lacking template and inline fields", async () => {
    await expect(
      api.sendEmail({ to: "x@example.com", identifiers: { email: "x@example.com" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("sends a transactional push", async () => {
    const res = await api.sendPush({ transactional_message_id: "3", identifiers: { id: "2" } });
    expect(res.delivery_id).toBeDefined();
    const dels = await raw("GET", "/__parlel/deliveries");
    expect(dels.body.deliveries[0].channel).toBe("push");
  });

  it("sends a transactional sms", async () => {
    const res = await api.sendSMS({ transactional_message_id: "5", identifiers: { id: "2" }, to: "+15555555555" });
    expect(res.delivery_id).toBeDefined();
  });

  it("sends an inbox message", async () => {
    const res = await api.sendInboxMessage({ transactional_message_id: "7", identifiers: { id: "2" } });
    expect(res.delivery_id).toBeDefined();
  });

  it("sends an in-app message", async () => {
    const res = await api.sendInApp({ transactional_message_id: "9", identifiers: { id: "2" } });
    expect(res.delivery_id).toBeDefined();
  });

  it("rejects push without transactional_message_id", async () => {
    await expect(api.sendPush({ identifiers: { id: "2" } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("can fetch a single delivery by id", async () => {
    const res = await api.sendPush({ transactional_message_id: "1", identifiers: { id: "2" } });
    const single = await raw("GET", `/__parlel/deliveries/${res.delivery_id}`);
    expect(single.status).toBe(200);
    expect(single.body.delivery_id).toBe(res.delivery_id);
  });
});

describe("customerio: APIClient.getCustomersByEmail", () => {
  it("returns matching customers", async () => {
    await cio.identify("1", { email: "match@example.com" });
    await cio.identify("2", { email: "other@example.com" });
    const res = await api.getCustomersByEmail("match@example.com");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe("1");
  });

  it("returns empty results when no match", async () => {
    const res = await api.getCustomersByEmail("nobody@example.com");
    expect(res.results).toEqual([]);
  });

  it("throws for empty email", () => {
    expect(() => api.getCustomersByEmail("")).toThrow();
  });
});

describe("customerio: APIClient.getAttributes", () => {
  it("returns attributes by id", async () => {
    await cio.identify("1", { email: "a@example.com", plan: "pro" });
    const res = await api.getAttributes("1", "id");
    expect(res.customer.attributes.plan).toBe("pro");
    expect(res.customer.id).toBe("1");
  });

  it("returns attributes by email", async () => {
    await cio.identify("1", { email: "byemail@example.com", plan: "gold" });
    const res = await api.getAttributes("byemail@example.com", "email");
    expect(res.customer.attributes.plan).toBe("gold");
  });

  it("returns attributes by cio_id", async () => {
    await cio.identify("1", { email: "z@example.com" });
    const got = await raw("GET", "/__parlel/customers/1");
    const cioId = got.body.cio_id;
    const res = await api.getAttributes(cioId, "cio_id");
    expect(res.customer.cio_id).toBe(cioId);
  });

  it("404s for unknown customer", async () => {
    await expect(api.getAttributes("ghost", "id")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws for empty id", () => {
    expect(() => api.getAttributes("")).toThrow(MissingParamError);
  });
});

describe("customerio: APIClient.triggerBroadcast", () => {
  it("triggers a broadcast with data + recipients", async () => {
    const res = await api.triggerBroadcast(1, { name: "foo" }, { segment: { id: 7 } });
    expect(res.id).toBeDefined();
    const bc = await raw("GET", "/__parlel/broadcasts");
    expect(bc.body.count).toBe(1);
    expect(bc.body.broadcasts[0].campaign_id).toBe("1");
    expect(bc.body.broadcasts[0].payload.recipients.segment.id).toBe(7);
  });

  it("triggers a broadcast with emails", async () => {
    const res = await api.triggerBroadcast(2, { name: "bar" }, { emails: ["a@example.com"], email_ignore_missing: true });
    expect(res.id).toBeDefined();
  });
});

describe("customerio: APIClient exports", () => {
  it("creates a customers export", async () => {
    const res = await api.createCustomersExport({ and: [{ segment: { id: 3 } }] });
    expect(res.export.id).toBeDefined();
    expect(res.export.type).toBe("customers");
    expect(res.export.status).toBe("ready");
  });

  it("creates a deliveries export", async () => {
    const res = await api.createDeliveriesExport(1, { start: 1666950084, end: 1666950084, metric: "attempted" });
    expect(res.export.type).toBe("deliveries");
    expect(res.export.params.newsletter_id).toBe(1);
  });

  it("lists exports", async () => {
    await api.createCustomersExport({ and: [{ segment: { id: 1 } }] });
    await api.createDeliveriesExport(2);
    const res = await api.listExports();
    expect(res.exports).toHaveLength(2);
  });

  it("gets a single export", async () => {
    const created = await api.createCustomersExport({ and: [] });
    const res = await api.getExport(created.export.id);
    expect(res.export.id).toBe(created.export.id);
  });

  it("downloads an export (signed link)", async () => {
    const created = await api.createCustomersExport({ and: [] });
    const res = await api.downloadExport(created.export.id);
    expect(res.link || res.export.signed_url).toBeDefined();
  });

  it("404s for unknown export", async () => {
    await expect(api.getExport(99999)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects createCustomersExport without filters", async () => {
    const res = await raw("POST", "/v1/exports/customers", {}, { Authorization: `Bearer ${APP_KEY}` });
    expect(res.status).toBe(400);
  });

  it("throws client-side for missing args", () => {
    expect(() => api.getExport("")).toThrow(MissingParamError);
    expect(() => api.downloadExport("")).toThrow(MissingParamError);
    expect(() => api.createCustomersExport(null as any)).toThrow(MissingParamError);
    expect(() => api.createDeliveriesExport(NaN)).toThrow(MissingParamError);
  });
});

describe("customerio: PipelinesClient", () => {
  it("identify", async () => {
    const res = await pipelines.identify({ userId: "1", traits: { email: "a@example.com", plan: "pro" } });
    expect(res.success).toBe(true);
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.events[0].type).toBe("identify");
    expect(evts.body.events[0].userId).toBe("1");
    expect(evts.body.events[0].messageId).toBeDefined();
    expect(evts.body.events[0].timestamp).toBeDefined();
  });

  it("track", async () => {
    await pipelines.track({ userId: "1", event: "Order Completed", properties: { price: 23.45 } });
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.events[0].event).toBe("Order Completed");
  });

  it("page", async () => {
    await pipelines.page({ userId: "1", name: "Pricing", properties: { path: "/pricing" } });
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.events[0].type).toBe("page");
  });

  it("screen", async () => {
    await pipelines.screen({ userId: "1", name: "Settings" });
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.events[0].type).toBe("screen");
  });

  it("group", async () => {
    await pipelines.group({ userId: "1", groupId: "acme-co", traits: { plan: "enterprise" } });
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.events[0].groupId).toBe("acme-co");
  });

  it("alias", async () => {
    await pipelines.alias({ userId: "1", previousId: "anon-abc-123" });
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.events[0].previousId).toBe("anon-abc-123");
  });

  it("batch", async () => {
    await pipelines.batch([
      { type: "identify", userId: "1", traits: { plan: "pro" } },
      { type: "track", userId: "1", event: "Subscribed" },
    ]);
    const evts = await raw("GET", "/__parlel/pipeline-events");
    expect(evts.body.count).toBe(2);
  });

  it("throws client-side guards", () => {
    expect(() => pipelines.identify({} as any)).toThrow(MissingParamError);
    expect(() => pipelines.track({ userId: "1" } as any)).toThrow(MissingParamError);
    expect(() => pipelines.group({ userId: "1" } as any)).toThrow(MissingParamError);
    expect(() => pipelines.alias({ userId: "1" } as any)).toThrow(MissingParamError);
  });

  it("rejects track without event server-side", async () => {
    const res = await raw("POST", "/v1/track", { userId: "1" }, { Authorization: basicAuth(WRITE_KEY, "") });
    expect(res.status).toBe(400);
  });

  it("rejects empty pipelines batch server-side", async () => {
    const res = await raw("POST", "/v1/batch", { batch: [] }, { Authorization: basicAuth(WRITE_KEY, "") });
    expect(res.status).toBe(400);
  });
});

describe("customerio: state reset", () => {
  it("clears all captured state", async () => {
    await cio.identify("1", { email: "a@example.com" });
    await cio.track("1", { name: "x" });
    await api.sendPush({ transactional_message_id: "1", identifiers: { id: "1" } });
    await raw("POST", "/__parlel/reset");
    const customers = await raw("GET", "/__parlel/customers");
    const events = await raw("GET", "/__parlel/events");
    const dels = await raw("GET", "/__parlel/deliveries");
    expect(customers.body.count).toBe(0);
    expect(events.body.count).toBe(0);
    expect(dels.body.count).toBe(0);
  });
});

describe("customerio: error shapes", () => {
  it("returns Customer.io meta.error envelope on 404", async () => {
    const res = await raw("GET", "/v1/exports/99999", undefined, { Authorization: `Bearer ${APP_KEY}` });
    expect(res.status).toBe(404);
    expect(res.body.meta.error).toBeDefined();
  });

  it("returns meta.errors envelope on validation failure", async () => {
    const res = await raw("POST", "/api/v1/customers/1/events", {}, { Authorization: basicAuth(SITE_ID, API_KEY) });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.meta.errors)).toBe(true);
  });

  it("rejects malformed JSON", async () => {
    const response = await fetch(`${BASE_URL}/api/v1/customers/1`, {
      method: "PUT",
      headers: { Authorization: basicAuth(SITE_ID, API_KEY), "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});
