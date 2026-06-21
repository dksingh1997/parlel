import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SegmentServer } from "../services/segment/src/server.js";

const PORT = 14815;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = { Authorization: `Basic ${Buffer.from("parlel:").toString("base64")}` };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = BASIC) {
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

describe("Segment Service", () => {
  let server: SegmentServer;

  beforeAll(async () => {
    server = new SegmentServer(PORT);
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
      expect(root.body.name).toBe("segment");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v1/track`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing write key", async () => {
      const response = await fetch(`${BASE_URL}/v1/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "u1", event: "X" }),
      });
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth with write key as username", async () => {
      const result = await api("POST", "/v1/track", { userId: "u1", event: "Signed Up" });
      expect(result.status).toBe(200);
    });
  });

  describe("Tracking endpoints", () => {
    it("POST /v1/track returns 200 {} and captures", async () => {
      const result = await api("POST", "/v1/track", { userId: "u1", event: "Order Completed", properties: { total: 99 } });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({});
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.count).toBe(1);
      expect(captured.body.events[0].type).toBe("track");
      expect(captured.body.events[0].event).toBe("Order Completed");
    });

    it("POST /v1/identify captures traits", async () => {
      const result = await api("POST", "/v1/identify", { userId: "u1", traits: { email: "a@parlel.dev" } });
      expect(result.status).toBe(200);
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.events[0].type).toBe("identify");
      expect(captured.body.events[0].traits.email).toBe("a@parlel.dev");
    });

    it("POST /v1/page captures", async () => {
      const result = await api("POST", "/v1/page", { userId: "u1", name: "Home" });
      expect(result.status).toBe(200);
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.events[0].type).toBe("page");
    });

    it("POST /v1/group captures", async () => {
      const result = await api("POST", "/v1/group", { userId: "u1", groupId: "g1", traits: { plan: "pro" } });
      expect(result.status).toBe(200);
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.events[0].type).toBe("group");
      expect(captured.body.events[0].groupId).toBe("g1");
    });
  });

  describe("Batch", () => {
    it("POST /v1/batch ingests multiple typed messages", async () => {
      const result = await api("POST", "/v1/batch", {
        batch: [
          { type: "track", userId: "u1", event: "A" },
          { type: "identify", userId: "u1", traits: { email: "x@parlel.dev" } },
          { type: "page", userId: "u1", name: "Pricing" },
        ],
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({});
      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.count).toBe(3);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/v1/track", { userId: "u", event: "X" });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/events");
      expect(after.body.count).toBe(0);
    });
  });
});
