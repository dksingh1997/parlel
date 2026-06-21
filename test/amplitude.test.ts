import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AmplitudeServer } from "../services/amplitude/src/server.js";

const PORT = 14809;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestKey";

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
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Amplitude Service", () => {
  let server: AmplitudeServer;

  beforeAll(async () => {
    server = new AmplitudeServer(PORT);
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
      expect(root.body.name).toBe("amplitude");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/2/httpapi`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("POST /2/httpapi", () => {
    it("ingests events and returns the documented v2 shape", async () => {
      const result = await api("POST", "/2/httpapi", {
        api_key: API_KEY,
        events: [
          { event_type: "Signup", user_id: "user-1", event_properties: { plan: "pro" } },
          { event_type: "Login", user_id: "user-1" },
        ],
      });
      expect(result.status).toBe(200);
      expect(result.body.code).toBe(200);
      expect(result.body.events_ingested).toBe(2);
      expect(typeof result.body.payload_size_bytes).toBe("number");
      expect(typeof result.body.server_upload_time).toBe("number");

      const captured = await api("GET", "/__parlel/events");
      expect(captured.body.count).toBe(2);
    });

    it("rejects missing api_key with 400", async () => {
      const result = await api("POST", "/2/httpapi", { events: [{ event_type: "X", user_id: "u" }] });
      expect(result.status).toBe(400);
    });

    it("rejects missing events with 400", async () => {
      const result = await api("POST", "/2/httpapi", { api_key: API_KEY, events: [] });
      expect(result.status).toBe(400);
    });
  });

  describe("POST /batch", () => {
    it("ingests via the batch endpoint", async () => {
      const result = await api("POST", "/batch", {
        api_key: API_KEY,
        events: [{ event_type: "Batched", user_id: "u9" }],
      });
      expect(result.status).toBe(200);
      expect(result.body.events_ingested).toBe(1);
    });
  });

  describe("POST /identify", () => {
    it("ingests user identifications", async () => {
      const result = await api("POST", "/identify", {
        api_key: API_KEY,
        identification: JSON.stringify([
          { user_id: "u1", user_properties: { $set: { plan: "enterprise" } } },
        ]),
      });
      expect(result.status).toBe(200);
      expect(result.body.identifies_ingested).toBe(1);
      const users = await api("GET", "/__parlel/users");
      expect(users.body.count).toBe(1);
      expect(users.body.users[0].user_properties.plan).toBe("enterprise");
    });
  });

  describe("POST /api/2/usersearch", () => {
    it("finds a user by id after ingestion", async () => {
      await api("POST", "/2/httpapi", {
        api_key: API_KEY,
        events: [{ event_type: "X", user_id: "findme" }],
      });
      const result = await api("POST", "/api/2/usersearch?user=findme", {});
      expect(result.status).toBe(200);
      expect(result.body.matches.length).toBe(1);
      expect(result.body.matches[0].user_id).toBe("findme");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/2/httpapi", { api_key: API_KEY, events: [{ event_type: "X", user_id: "u" }] });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/events");
      expect(after.body.count).toBe(0);
    });
  });
});
