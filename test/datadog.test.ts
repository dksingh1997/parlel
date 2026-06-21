import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DatadogServer } from "../services/datadog/src/server.js";

const PORT = 14810;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { "DD-API-KEY": "parlel", "DD-APPLICATION-KEY": "parlel-app" };

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

describe("Datadog Service", () => {
  let server: DatadogServer;

  beforeAll(async () => {
    server = new DatadogServer(PORT);
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
      expect(root.body.name).toBe("datadog");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/series`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing DD-API-KEY", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/series`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ series: [] }),
      });
      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/v1/series", () => {
    it("submits metrics and returns {status:'ok'}", async () => {
      const result = await api("POST", "/api/v1/series", {
        series: [{ metric: "app.requests", points: [[Math.floor(Date.now() / 1000), 42]], type: "count", tags: ["env:test"] }],
      });
      expect(result.status).toBe(202);
      expect(result.body.status).toBe("ok");
      const captured = await api("GET", "/__parlel/metrics");
      expect(captured.body.count).toBe(1);
      expect(captured.body.metrics[0].metric).toBe("app.requests");
    });
  });

  describe("POST /api/v2/logs", () => {
    it("submits logs", async () => {
      const result = await api("POST", "/api/v2/logs", [
        { message: "hello", ddsource: "nodejs", service: "parlel" },
      ] as any);
      expect(result.status).toBe(202);
      const captured = await api("GET", "/__parlel/logs");
      expect(captured.body.count).toBe(1);
    });
  });

  describe("Events", () => {
    it("posts and retrieves an event", async () => {
      const created = await api("POST", "/api/v1/events", { title: "Deploy", text: "v1.2.3", tags: ["env:prod"] });
      expect(created.status).toBe(202);
      const id = created.body.event.id;
      const got = await api("GET", `/api/v1/events/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.event.title).toBe("Deploy");
      const list = await api("GET", "/api/v1/events");
      expect(list.body.events.length).toBe(1);
    });

    it("returns 404 for unknown event", async () => {
      const result = await api("GET", "/api/v1/events/99999999999999");
      expect(result.status).toBe(404);
    });
  });

  describe("Dashboards", () => {
    it("lists seeded dashboards", async () => {
      const result = await api("GET", "/api/v1/dashboard");
      expect(result.body.dashboards.length).toBeGreaterThanOrEqual(1);
    });

    it("creates, retrieves, updates and deletes a dashboard", async () => {
      const created = await api("POST", "/api/v1/dashboard", { title: "My Dash", layout_type: "ordered", widgets: [] });
      expect(created.status).toBe(200);
      const id = created.body.id;
      const got = await api("GET", `/api/v1/dashboard/${id}`);
      expect(got.body.title).toBe("My Dash");
      const updated = await api("PUT", `/api/v1/dashboard/${id}`, { title: "Renamed" });
      expect(updated.body.title).toBe("Renamed");
      const deleted = await api("DELETE", `/api/v1/dashboard/${id}`);
      expect(deleted.body.deleted_dashboard_id).toBe(id);
    });
  });

  describe("POST /api/v1/check_run", () => {
    it("submits a service check", async () => {
      const result = await api("POST", "/api/v1/check_run", {
        check: "app.is_ok",
        host_name: "host1",
        status: 0,
        tags: ["env:test"],
      });
      expect(result.status).toBe(202);
      expect(result.body.status).toBe("ok");
      const captured = await api("GET", "/__parlel/check_runs");
      expect(captured.body.count).toBe(1);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/api/v1/series", { series: [{ metric: "x", points: [[1, 1]] }] });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/metrics");
      expect(after.body.count).toBe(0);
    });
  });
});
