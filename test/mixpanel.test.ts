import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MixpanelServer } from "../services/mixpanel/src/server.js";

const PORT = 14808;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = { Authorization: `Basic ${Buffer.from("parlel:").toString("base64")}` };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

describe("Mixpanel Service", () => {
  let server: MixpanelServer;

  beforeAll(async () => {
    server = new MixpanelServer(PORT);
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
      expect(root.body.name).toBe("mixpanel");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/track`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("POST /track", () => {
    it("ingests an event from a JSON body and returns 1", async () => {
      const result = await api("POST", "/track", {
        event: "Signed Up",
        properties: { distinct_id: "u1", token: "parlel", plan: "pro" },
      }, BASIC);
      expect(result.status).toBe(200);
      expect(result.body).toBe(1);
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.count).toBe(1);
      expect(captured.body.events[0].event).toBe("Signed Up");
    });

    it("ingests a base64 `data` param", async () => {
      const payload = JSON.stringify({ event: "Page View", properties: { distinct_id: "u2", token: "parlel" } });
      const b64 = Buffer.from(payload).toString("base64");
      const response = await fetch(`${BASE_URL}/track?data=${encodeURIComponent(b64)}`, { method: "POST" });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toBe(1);
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.count).toBe(1);
      expect(captured.body.events[0].event).toBe("Page View");
    });

    it("ingests an array of events", async () => {
      const result = await api("POST", "/track", [
        { event: "A", properties: { distinct_id: "u1" } },
        { event: "B", properties: { distinct_id: "u2" } },
      ] as any, BASIC);
      expect(result.body).toBe(1);
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.count).toBe(2);
    });
  });

  describe("POST /import", () => {
    it("imports historical events", async () => {
      const result = await api("POST", "/import", [
        { event: "Historical", properties: { distinct_id: "u1", time: 1000 } },
      ] as any, BASIC);
      expect(result.status).toBe(200);
      expect(result.body.num_records_imported).toBe(1);
      expect(result.body.status).toBe("OK");
    });
  });

  describe("POST /engage", () => {
    it("sets people properties", async () => {
      const result = await api("POST", "/engage", {
        $token: "parlel",
        $distinct_id: "u1",
        $set: { "$email": "a@parlel.dev", plan: "pro" },
      }, BASIC);
      expect(result.body).toBe(1);
      const people = await api("GET", "/__parlel/people");
      expect(people.body.count).toBe(1);
      expect(people.body.people[0].$properties.plan).toBe("pro");
    });

    it("$set_once does not overwrite existing", async () => {
      await api("POST", "/engage", { $distinct_id: "u1", $set: { plan: "pro" } }, BASIC);
      await api("POST", "/engage", { $distinct_id: "u1", $set_once: { plan: "free" } }, BASIC);
      const people = await api("GET", "/__parlel/people");
      expect(people.body.people[0].$properties.plan).toBe("pro");
    });
  });

  describe("GET /api/2.0/events", () => {
    it("queries captured events", async () => {
      await api("POST", "/track", { event: "Purchase", properties: { distinct_id: "u1" } }, BASIC);
      await api("POST", "/track", { event: "Refund", properties: { distinct_id: "u2" } }, BASIC);
      const result = await api("GET", `/api/2.0/events?event=${encodeURIComponent(JSON.stringify(["Purchase"]))}`, undefined, BASIC);
      expect(result.status).toBe(200);
      expect(result.body.events.length).toBe(1);
      expect(result.body.events[0].event).toBe("Purchase");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/track", { event: "X", properties: { distinct_id: "u" } }, BASIC);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/events");
      expect(after.body.count).toBe(0);
    });
  });
});
