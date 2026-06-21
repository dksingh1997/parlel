import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CalComServer } from "../services/cal-com/src/server.js";

const PORT = 14849;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "cal_parlelTestKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
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

describe("Cal.com Service", () => {
  let server: CalComServer;

  beforeAll(async () => {
    server = new CalComServer(PORT);
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

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("cal-com");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/v2/me`, { method: "GET" });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.status).toBe("error");
    });

    it("accepts Bearer cal_ key", async () => {
      const result = await api("GET", "/v2/me");
      expect(result.status).toBe(200);
    });

    it("accepts ?apiKey= for v1-style", async () => {
      const response = await fetch(`${BASE_URL}/v1/me?apiKey=${API_KEY}`, { method: "GET" });
      expect(response.status).toBe(200);
    });
  });

  describe("Success shape", () => {
    it("GET /v2/me wraps in {status:'success', data}", async () => {
      const result = await api("GET", "/v2/me");
      expect(result.body.status).toBe("success");
      expect(result.body.data.username).toBe("parlel");
    });
  });

  describe("Event types and slots", () => {
    it("lists event types", async () => {
      const result = await api("GET", "/v2/event-types");
      expect(result.status).toBe(200);
      expect(result.body.data.eventTypes.length).toBeGreaterThanOrEqual(2);
    });

    it("returns slots", async () => {
      const result = await api("GET", "/v2/slots?eventTypeId=1&start=2024-06-01&end=2024-06-02");
      expect(result.status).toBe(200);
      expect(typeof result.body.data).toBe("object");
    });
  });

  describe("Bookings CRUD round-trip", () => {
    it("creates, retrieves, lists and cancels a booking", async () => {
      const created = await api("POST", "/v2/bookings", {
        start: "2024-06-01T09:00:00.000Z",
        eventTypeId: 1,
        attendee: { name: "Alice", email: "alice@parlel.dev", timeZone: "UTC" },
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("success");
      const uid = created.body.data.uid;
      expect(uid).toBeTruthy();

      const got = await api("GET", `/v2/bookings/${uid}`);
      expect(got.status).toBe(200);
      expect(got.body.data.uid).toBe(uid);

      const list = await api("GET", "/v2/bookings");
      expect(list.body.data.length).toBe(1);

      const cancelled = await api("POST", `/v2/bookings/${uid}/cancel`, { reason: "test" });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe("cancelled");
    });

    it("404 unknown booking", async () => {
      const result = await api("GET", "/v2/bookings/nope");
      expect(result.status).toBe(404);
    });
  });
});
