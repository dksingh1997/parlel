import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DripServer } from "../services/drip/src/server.js";

const PORT = 14833;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "9999999";
const AUTH = { Authorization: `Basic ${Buffer.from("parlel-drip-token:").toString("base64")}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: any, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Drip Service", () => {
  let server: DripServer;

  beforeAll(async () => {
    server = new DripServer(PORT);
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
      expect(root.body.name).toBe("drip");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v2/${ACCOUNT}/subscribers`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/v2/${ACCOUNT}/subscribers`);
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const result = await api("GET", `/v2/${ACCOUNT}/subscribers`);
      expect(result.status).toBe(200);
    });
  });

  describe("Subscribers", () => {
    it("creates a subscriber wrapped in subscribers array", async () => {
      const created = await api("POST", `/v2/${ACCOUNT}/subscribers`, {
        subscribers: [{ email: "s@parlel.dev", custom_fields: { name: "S" }, tags: ["lead"] }],
      });
      expect(created.status).toBe(201);
      expect(created.body.subscribers[0].email).toBe("s@parlel.dev");
      const id = created.body.subscribers[0].id;

      const got = await api("GET", `/v2/${ACCOUNT}/subscribers/${id}`);
      expect(got.status).toBe(200);

      const byEmail = await api("GET", `/v2/${ACCOUNT}/subscribers/${encodeURIComponent("s@parlel.dev")}`);
      expect(byEmail.status).toBe(200);

      const list = await api("GET", `/v2/${ACCOUNT}/subscribers`);
      expect(list.body.subscribers.length).toBe(1);
      expect(list.body.meta.total_count).toBe(1);
    });

    it("upserts an existing subscriber by email", async () => {
      await api("POST", `/v2/${ACCOUNT}/subscribers`, { subscribers: [{ email: "u@parlel.dev" }] });
      const second = await api("POST", `/v2/${ACCOUNT}/subscribers`, {
        subscribers: [{ email: "u@parlel.dev", custom_fields: { name: "Updated" } }],
      });
      expect(second.status).toBe(200);
      expect(second.body.subscribers[0].custom_fields.name).toBe("Updated");
      const list = await api("GET", `/v2/${ACCOUNT}/subscribers`);
      expect(list.body.subscribers.length).toBe(1);
    });

    it("rejects invalid email", async () => {
      const result = await api("POST", `/v2/${ACCOUNT}/subscribers`, { subscribers: [{ email: "bad" }] });
      expect(result.status).toBe(422);
    });

    it("deletes a subscriber", async () => {
      const created = await api("POST", `/v2/${ACCOUNT}/subscribers`, { subscribers: [{ email: "d@parlel.dev" }] });
      const id = created.body.subscribers[0].id;
      const deleted = await api("DELETE", `/v2/${ACCOUNT}/subscribers/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v2/${ACCOUNT}/subscribers/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Events", () => {
    it("records an event and captures it", async () => {
      const result = await api("POST", `/v2/${ACCOUNT}/events`, {
        events: [{ email: "s@parlel.dev", action: "Purchased", properties: { sku: "A1" } }],
      });
      expect(result.status).toBe(204);
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
    });

    it("rejects events missing action", async () => {
      const result = await api("POST", `/v2/${ACCOUNT}/events`, { events: [{ email: "s@parlel.dev" }] });
      expect(result.status).toBe(422);
    });
  });

  describe("Campaigns", () => {
    it("lists campaigns (seeded default present)", async () => {
      const result = await api("GET", `/v2/${ACCOUNT}/campaigns`);
      expect(result.status).toBe(200);
      expect(result.body.campaigns.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", `/v2/${ACCOUNT}/events`, { events: [{ email: "s@parlel.dev", action: "x" }] });
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
