import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MailgunServer } from "../services/mailgun/src/server.js";

const PORT = 14826;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DOMAIN = "sandbox.parlel";
const AUTH = { Authorization: `Basic ${Buffer.from("api:key-parlel").toString("base64")}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function form(path: string, fields: Record<string, string | string[]>, headers: Json = AUTH): Promise<ApiResult> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.append(k, v);
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Mailgun Service", () => {
  let server: MailgunServer;

  beforeAll(async () => {
    server = new MailgunServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("mailgun");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v3/${DOMAIN}/messages`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/v3/${DOMAIN}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "from=a@parlel.dev&to=b@parlel.dev",
      });
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const result = await form(`/v3/${DOMAIN}/messages`, {
        from: "a@parlel.dev",
        to: "b@parlel.dev",
        subject: "Hi",
        text: "Body",
      });
      expect(result.status).toBe(200);
    });
  });

  describe("POST /v3/:domain/messages", () => {
    it("sends a message from urlencoded form and returns queued response", async () => {
      const result = await form(`/v3/${DOMAIN}/messages`, {
        from: "Excited User <mailgun@sandbox.parlel>",
        to: "user@parlel.dev",
        subject: "Hello",
        text: "Testing Mailgun!",
      });
      expect(result.status).toBe(200);
      expect(result.body.message).toBe("Queued. Thank you.");
      expect(result.body.id).toMatch(/@/);
    });

    it("captures the sent message for inspection", async () => {
      const result = await form(`/v3/${DOMAIN}/messages`, {
        from: "from@parlel.dev",
        to: "to@parlel.dev",
        subject: "Captured",
        html: "<b>hi</b>",
      });
      const id = result.body.id;
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
      expect(inbox.body.messages[0].subject).toBe("Captured");
      expect(inbox.body.messages[0].form.html).toBe("<b>hi</b>");
      const one = await api("GET", `/__parlel/messages/${encodeURIComponent(id)}`);
      expect(one.status).toBe(200);
    });

    it("parses multiple recipients into an array", async () => {
      await form(`/v3/${DOMAIN}/messages`, {
        from: "from@parlel.dev",
        to: ["a@parlel.dev", "b@parlel.dev"],
        subject: "Multi",
        text: "x",
      });
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.messages[0].to).toEqual(["a@parlel.dev", "b@parlel.dev"]);
    });

    it("rejects missing from", async () => {
      const result = await form(`/v3/${DOMAIN}/messages`, { to: "b@parlel.dev", subject: "x" });
      expect(result.status).toBe(400);
    });

    it("creates an accepted event for each send", async () => {
      await form(`/v3/${DOMAIN}/messages`, { from: "a@parlel.dev", to: "b@parlel.dev", subject: "x", text: "y" });
      const events = await api("GET", `/v3/${DOMAIN}/events`);
      expect(events.status).toBe(200);
      expect(events.body.items.length).toBe(1);
      expect(events.body.items[0].event).toBe("accepted");
    });

    // The official mailgun.js SDK runs `new URL(pageUrl)` over every value in
    // body.paging (NavigationThruPages.parsePage). Empty strings would throw
    // `Invalid URL`, so paging values must be absolute URLs.
    it("returns events paging as absolute URLs (SDK-parseable)", async () => {
      const events = await api("GET", `/v3/${DOMAIN}/events`);
      expect(events.status).toBe(200);
      expect(events.body.paging).toBeTruthy();
      for (const url of Object.values(events.body.paging) as string[]) {
        expect(() => new URL(url)).not.toThrow();
      }
    });
  });

  // Real API + official SDK route mailing lists at /v3/lists (mg.lists.*).
  describe("Mailing lists (/v3/lists)", () => {
    it("creates and lists a mailing list", async () => {
      const created = await api("POST", "/v3/lists", { address: "dev@parlel.dev", name: "Devs" });
      expect(created.status).toBe(200);
      expect(created.body.list.address).toBe("dev@parlel.dev");
      // matches the SDK MailingList type: reply_preference present (nullable)
      expect(created.body.list).toHaveProperty("reply_preference");
      expect(created.body.list).toHaveProperty("members_count", 0);

      const listPages = await api("GET", "/v3/lists/pages");
      expect(listPages.status).toBe(200);
      expect(listPages.body.items.length).toBe(1);
      // paging values must be absolute URLs for the SDK's `new URL()` call
      for (const url of Object.values(listPages.body.paging) as string[]) {
        expect(() => new URL(url)).not.toThrow();
      }
    });

    it("gets a single mailing list by address", async () => {
      await api("POST", "/v3/lists", { address: "team@parlel.dev", name: "Team" });
      const one = await api("GET", `/v3/lists/${encodeURIComponent("team@parlel.dev")}`);
      expect(one.status).toBe(200);
      expect(one.body.list.address).toBe("team@parlel.dev");
    });

    it("deletes a mailing list", async () => {
      await api("POST", "/v3/lists", { address: "gone@parlel.dev" });
      const del = await api("DELETE", `/v3/lists/${encodeURIComponent("gone@parlel.dev")}`);
      expect(del.status).toBe(200);
      expect(del.body.address).toBe("gone@parlel.dev");
      expect(del.body.message).toMatch(/deleted/i);
      const missing = await api("GET", `/v3/lists/${encodeURIComponent("gone@parlel.dev")}`);
      expect(missing.status).toBe(404);
    });

    it("rejects mailing list without address (400 + message envelope)", async () => {
      const result = await api("POST", "/v3/lists", {});
      expect(result.status).toBe(400);
      expect(typeof result.body.message).toBe("string");
    });

    it("404s an unknown list with the message envelope", async () => {
      const result = await api("GET", `/v3/lists/${encodeURIComponent("nope@parlel.dev")}`);
      expect(result.status).toBe(404);
      expect(typeof result.body.message).toBe("string");
    });
  });

  // Legacy alias kept working for backwards compatibility.
  describe("Mailing lists (legacy /v3/:domain/mailing_lists alias)", () => {
    it("creates and lists via the legacy path", async () => {
      const created = await api("POST", `/v3/${DOMAIN}/mailing_lists`, { address: "legacy@parlel.dev", name: "Legacy" });
      expect(created.status).toBe(200);
      expect(created.body.list.address).toBe("legacy@parlel.dev");
      const list = await api("GET", `/v3/${DOMAIN}/mailing_lists`);
      expect(list.body.items.length).toBe(1);
    });

    it("rejects mailing list without address", async () => {
      const result = await api("POST", `/v3/${DOMAIN}/mailing_lists`, {});
      expect(result.status).toBe(400);
    });
  });

  describe("Domains", () => {
    it("lists domains via /v4/domains (SDK domains.list)", async () => {
      const result = await api("GET", "/v4/domains");
      expect(result.status).toBe(200);
      expect(result.body.items.length).toBeGreaterThanOrEqual(1);
      expect(result.body.items[0].name).toBe("sandbox.parlel");
      // SDK Domain model fields populated for realism
      expect(result.body.items[0]).toHaveProperty("type", "sandbox");
      expect(result.body.items[0]).toHaveProperty("state", "active");
      expect(result.body).toHaveProperty("total_count");
    });

    it("lists domains via the legacy /v3/domains alias", async () => {
      const result = await api("GET", "/v3/domains");
      expect(result.status).toBe(200);
      expect(result.body.items[0].name).toBe("sandbox.parlel");
    });
  });

  describe("parlel inspection", () => {
    it("resets captured messages", async () => {
      await form(`/v3/${DOMAIN}/messages`, { from: "a@parlel.dev", to: "b@parlel.dev", subject: "x", text: "y" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });

    it("clears mailbox only", async () => {
      await form(`/v3/${DOMAIN}/messages`, { from: "a@parlel.dev", to: "b@parlel.dev", subject: "x", text: "y" });
      const cleared = await api("DELETE", "/__parlel/messages");
      expect(cleared.status).toBe(200);
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
