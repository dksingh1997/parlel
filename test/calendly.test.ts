import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CalendlyServer } from "../services/calendly/src/server.js";

const PORT = 14813;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer parlelTestToken` };

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

describe("Calendly Service", () => {
  let server: CalendlyServer;

  beforeAll(async () => {
    server = new CalendlyServer(PORT);
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
      expect(root.body.name).toBe("calendly");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/users/me`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer token", async () => {
      const response = await fetch(`${BASE_URL}/users/me`);
      expect(response.status).toBe(401);
    });
  });

  describe("GET /users/me", () => {
    it("returns the {resource} wrapper", async () => {
      const result = await api("GET", "/users/me");
      expect(result.status).toBe(200);
      expect(result.body.resource).toBeDefined();
      expect(result.body.resource.uri).toContain("users/");
      expect(result.body.resource.email).toBeTruthy();
    });
  });

  describe("Event types", () => {
    it("lists event types in {collection,pagination} shape", async () => {
      const userUri = (await api("GET", "/users/me")).body.resource.uri;
      const result = await api("GET", `/event_types?user=${encodeURIComponent(userUri)}`);
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.collection)).toBe(true);
      expect(result.body.collection.length).toBeGreaterThanOrEqual(1);
      expect(result.body.pagination).toBeDefined();
    });
  });

  describe("Scheduled events", () => {
    it("creates, lists and retrieves a scheduled event", async () => {
      const created = await api("POST", "/scheduled_events", { name: "Intro Call" });
      expect(created.status).toBe(201);
      expect(created.body.resource.status).toBe("active");
      const uuid = created.body.resource.uri.split("/").pop();

      const list = await api("GET", "/scheduled_events");
      expect(list.body.collection.length).toBe(1);

      const got = await api("GET", `/scheduled_events/${uuid}`);
      expect(got.status).toBe(200);
      expect(got.body.resource.name).toBe("Intro Call");
    });

    it("returns 404 for an unknown scheduled event", async () => {
      const result = await api("GET", "/scheduled_events/does-not-exist");
      expect(result.status).toBe(404);
    });
  });

  describe("Scheduling links", () => {
    it("creates a scheduling link", async () => {
      const etUri = "https://api.calendly.com/event_types/et-default";
      const result = await api("POST", "/scheduling_links", { max_event_count: 1, owner: etUri, owner_type: "EventType" });
      expect(result.status).toBe(201);
      expect(result.body.resource.booking_url).toContain("calendly.com");
    });

    it("rejects scheduling link without an owner", async () => {
      const result = await api("POST", "/scheduling_links", { max_event_count: 1 });
      expect(result.status).toBe(400);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/scheduled_events", { name: "X" });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/scheduled_events");
      expect(after.body.count).toBe(0);
    });
  });
});
