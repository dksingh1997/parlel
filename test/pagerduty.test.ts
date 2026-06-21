import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PagerdutyServer } from "../services/pagerduty/src/server.js";

const PORT = 14774;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = {
  Authorization: "Token token=pd_parlelTestKey",
  Accept: "application/vnd.pagerduty+json;version=2",
};

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("PagerDuty Service", () => {
  let server: PagerdutyServer;

  beforeAll(async () => {
    server = new PagerdutyServer(PORT);
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
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("pagerduty");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects REST API without Token auth (401)", async () => {
      const res = await fetch(`${BASE_URL}/incidents`);
      expect(res.status).toBe(401);
    });

    it("accepts Token token= auth", async () => {
      const res = await api("GET", "/incidents");
      expect(res.status).toBe(200);
    });
  });

  describe("Incidents", () => {
    it("lists, creates and updates incidents", async () => {
      const list = await api("GET", "/incidents");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.incidents)).toBe(true);

      const created = await api("POST", "/incidents", {
        incident: { type: "incident", title: "Server down", service: { id: "PSVC01", type: "service_reference" } },
      });
      expect(created.status).toBe(201);
      expect(created.body.incident.status).toBe("triggered");
      const id = created.body.incident.id;

      const got = await api("GET", `/incidents/${id}`);
      expect(got.body.incident.title).toBe("Server down");

      const updated = await api("PUT", `/incidents/${id}`, { incident: { status: "resolved" } });
      expect(updated.body.incident.status).toBe("resolved");
    });

    it("rejects incident without title", async () => {
      const res = await api("POST", "/incidents", { incident: { type: "incident" } });
      expect(res.status).toBe(400);
    });
  });

  describe("Services", () => {
    it("lists and creates services", async () => {
      const list = await api("GET", "/services");
      expect(list.body.services.length).toBeGreaterThanOrEqual(1);
      const created = await api("POST", "/services", { service: { type: "service", name: "API" } });
      expect(created.status).toBe(201);
      expect(created.body.service.name).toBe("API");
    });
  });

  describe("Users", () => {
    it("lists and creates users", async () => {
      const list = await api("GET", "/users");
      expect(list.body.users.length).toBeGreaterThanOrEqual(1);
      const created = await api("POST", "/users", { user: { type: "user", name: "Alice", email: "alice@parlel.dev" } });
      expect(created.status).toBe(201);
      expect(created.body.user.email).toBe("alice@parlel.dev");
    });
  });

  describe("Events API v2", () => {
    it("enqueues an event and returns success + dedup_key", async () => {
      const res = await api("POST", "/v2/enqueue", {
        routing_key: "parlelroutingkey0000000000000000",
        event_action: "trigger",
        payload: { summary: "boom", source: "host1", severity: "critical" },
      }, { "Content-Type": "application/json" } as any);
      expect(res.status).toBe(202);
      expect(res.body.status).toBe("success");
      expect(res.body.dedup_key).toBeTruthy();
    });

    it("rejects event without routing_key", async () => {
      const res = await api("POST", "/v2/enqueue", { event_action: "trigger" }, {} as any);
      expect(res.status).toBe(400);
    });
  });
});
